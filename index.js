// index.js (Final Version with Configurable Concurrency)

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Langfuse } = require('langfuse');
const JSONStream = require('jsonstream');
const csv = require('csv-parser');
require('dotenv').config();

const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const INPUT_FILE_TARGETS = 'all_targets.json';
const INPUT_FILE_LABELS = 'labels.csv';
const OUTPUT_FILE = 'labeled_targets.json';
const PROMPT_NAME = 'target-labeler';

const langfuse = new Langfuse();
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
if (openai) console.log("OpenAI client initialized.");
const googleGenAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;
if (googleGenAI) console.log("Google GenAI client initialized.");

// --- Helper Functions ---
async function loadAndMapLabels() {
    return new Promise((resolve, reject) => {
        const topicMap = new Map();
        const topicList = [];
        fs.createReadStream(path.join(__dirname, INPUT_FILE_LABELS)).pipe(csv())
            .on('data', (row) => {
                topicMap.set(row.Topic, { subject: row.Subject, category: row.Category });
                topicList.push(row.Topic);
            })
            .on('end', () => {
                const availableTopicsString = topicList.join(', ');
                resolve({ topicMap, availableTopicsString });
            })
            .on('error', reject);
    });
}
async function callOpenAI(trace, promptMessages, model, modelParameters) {
    if (!openai) throw new Error("OpenAI client not initialized.");
    const generation = trace.generation({ name: 'openai-direct-call', input: promptMessages, model, modelParameters });
    try {
        const completion = await openai.chat.completions.create({ model, messages: promptMessages, ...modelParameters });
        const output = completion.choices[0].message.content;
        generation.end({ output });
        return output;
    } catch (error) {
        generation.end({ level: "ERROR", statusMessage: error.message });
        throw error;
    }
}
async function callGoogle(trace, promptString, model, modelParameters) {
    if (!googleGenAI) throw new Error("Google client not initialized.");
    const googleModel = googleGenAI.getGenerativeModel({ model });
    const correctedParams = normalizeGoogleParams(modelParameters);
    const generation = trace.generation({ name: 'google-direct-call', input: promptString, model, modelParameters: correctedParams });
    try {
        const result = await googleModel.generateContent(promptString, correctedParams.generationConfig);
        const output = result.response.text();
        generation.end({ output });
        return output;
    } catch (error) {
        generation.end({ level: "ERROR", statusMessage: error.message });
        throw error;
    }
}
function normalizeGoogleParams(params) {
    if (!params) return {};
    const normalized = { generationConfig: { ...(params.generationConfig || {}) } };
    for (const key in params) {
        if (Object.prototype.hasOwnProperty.call(params, key) && key !== 'generationConfig') {
            normalized.generationConfig[key] = params[key];
        }
    }
    return normalized;
}


// --- Main Application Logic ---
app.post('/label-targets', async (req, res) => {
    const startTime = Date.now();
    let modelName;
    const filterTopics = req.body.Topic || [];
    console.log(filterTopics.length > 0 ? `Request received. Filtering for topics: [${filterTopics.join(', ')}]` : "Request received. No topic filter applied.");

    try {
        // --- NEW: Read the concurrency limit from the .env file ---
        const concurrency = parseInt(process.env.CONCURRENCY_LIMIT) || 15; // Default to 15 if not set
        console.log(`Using concurrency limit: ${concurrency}`);

        const pLimit = (await import('p-limit')).default;
        const limit = pLimit(concurrency);

        const { topicMap, availableTopicsJsonArrayString } = await loadAndMapLabels();
        const promptTemplate = await langfuse.getPrompt(PROMPT_NAME);
        const provider = promptTemplate.config.provider;
        modelName = promptTemplate.config.model || promptTemplate.config.modelName;
        console.log(`Configurations loaded. Dispatching to provider: ${provider}, Model: ${modelName}.`);

        const labeledTargets = await new Promise((resolve, reject) => {
            const labelingPromises = [];
            let targetCount = 0, processedCount = 0;
            const stream = fs.createReadStream(path.join(__dirname, INPUT_FILE_TARGETS), { encoding: 'utf8' });
            const parser = JSONStream.parse('data.search_results.targets.*');
            stream.pipe(parser);

            parser.on('data', (target) => {
                targetCount++;
                const hasMatchingTopic = filterTopics.length === 0 || target.topic?.some(t => filterTopics.includes(t));
                if (hasMatchingTopic) {
                    processedCount++;
                    // Wrap the async operation in the configured limiter
                    const labelingPromise = limit(async () => {
                        const simplifiedTarget = { Target_ID: target.id, Label: target.label, Description: target.description, Explanation: target.target_explanation };
                        const experimentalText = "---*Deze uitleg is experimenteel en wordt nog verder verbeterd.*";
                        if (simplifiedTarget.Explanation) {
                            simplifiedTarget.Explanation = simplifiedTarget.Explanation.replace(experimentalText, '').trim();
                        }
                    
                        const trace = langfuse.trace({ name: 'target-labeling-trace', metadata: { targetId: simplifiedTarget.Target_ID } });
                        let llmCompletion;
                        try {
                            const promptInput = {
                                label: simplifiedTarget.Label,
                                description: simplifiedTarget.Description,
                                explanation: simplifiedTarget.Explanation,
                                available_topics_json_array: availableTopicsJsonArrayString
                            };
                            const compiledPrompt = promptTemplate.compile(promptInput);

                            if (provider === 'OPENAI') {
                                llmCompletion = await callOpenAI(trace, compiledPrompt, modelName, promptTemplate.config.modelParameters);
                            } else if (provider === 'GOOGLE_GENAI') {
                                const promptString = compiledPrompt.map(m => `${m.role}: ${m.content}`).join('\n\n');
                                llmCompletion = await callGoogle(trace, promptString, modelName, promptTemplate.config.modelParameters);
                            } else { throw new Error(`Unsupported provider: ${provider}`); }

                            if (!llmCompletion) { throw new Error('Direct API call returned an empty completion.'); }
                            
                            const jsonMatch = llmCompletion.match(/\{[\s\S]*\}/);
                            if (!jsonMatch) { throw new Error(`Could not find a valid JSON object in the LLM's response. Raw response: ${llmCompletion}`); }
                            const jsonString = jsonMatch[0];
                            const llmResponse = JSON.parse(jsonString);
                            
                            const llmTopics = llmResponse.Topics || llmResponse.Topic || [];
                            const subjects = new Set();
                            const categories = new Set();

                            llmTopics.forEach(topicName => {
                                const mapping = topicMap.get(topicName);
                                if (mapping) {
                                    subjects.add(mapping.subject);
                                    categories.add(mapping.category);
                                } else {
                                    console.warn(`Warning: Topic "${topicName}" from LLM not found in labels.csv for Target ID ${simplifiedTarget.Target_ID}`);
                                }
                            });

                            trace.update({ input: promptInput, output: { ...llmResponse, derivedSubjects: Array.from(subjects), derivedCategories: Array.from(categories) } });

                            return { 
                                ...simplifiedTarget, 
                                Subject: Array.from(subjects),
                                Category: Array.from(categories),
                                Topic: llmTopics 
                            };
                        } catch (error) {
                            console.error(`--- ERROR PROCESSING TARGET ID: ${simplifiedTarget.Target_ID} ---`);
                            console.error(`Error Message: ${error.message}`);
                            trace.update({ level: 'ERROR', statusMessage: error.message });
                            return { ...simplifiedTarget, Subject: ['Error processing'], Category: ['Error processing'], Topic: ['Error processing'] };
                        }
                    });
                    labelingPromises.push(labelingPromise);
                }
            });

            parser.on('end', async () => {
                console.log(`Finished reading file. Scanned ${targetCount} targets, processing ${processedCount}. Waiting for all queued API calls to complete...`);
                try {
                    const results = await Promise.all(labelingPromises);
                    resolve(results);
                } catch (error) { reject(error); }
            });
            stream.on('error', (err) => reject(err));
            parser.on('error', (err) => reject(err));
        });

        fs.writeFileSync(path.join(__dirname, OUTPUT_FILE), JSON.stringify(labeledTargets, null, 2));
        console.log(`Processing complete. Output saved to ${OUTPUT_FILE}`);

        const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
        res.status(200).json({
            message: "Processing complete.",
            duration: `${durationSeconds} seconds`,
            "llm-model": modelName,
            data: labeledTargets
        });
    } catch (error) {
        const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error("An unexpected error occurred in the main process:", error);
        res.status(500).json({
            error: "An internal server error occurred.",
            duration: `${durationSeconds} seconds`,
            "llm-model": modelName || "Not determined due to error",
            details: error.message
        });
    }
});

app.listen(PORT, () => console.log(`Server is running on http://localhost:${PORT}`));