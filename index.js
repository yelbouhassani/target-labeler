// index.js (Complete, self-contained version for semantic matching)

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Langfuse } = require('langfuse');
const JSONStream = require('jsonstream');
const csv = require('csv-parser');
require('dotenv').config();

const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");

// --- Configuration ---
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const INPUT_FILE_TARGETS = 'all_targets.json';
const INPUT_FILE_LABELS = 'labels.csv';
const OUTPUT_FILE = 'labeled_targets.json';
const PROMPT_NAME = 'target-labeler';

// --- Initialize Clients ---
const langfuse = new Langfuse();
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
if (openai) console.log("OpenAI client initialized.");
const googleGenAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;
if (googleGenAI) console.log("Google GenAI client initialized.");


// --- Helper Functions ---

/**
 * Reads labels.csv, creates a lookup map (Topic -> {Subject, Category}),
 * and a structured list of topics with their terms for the LLM.
 * It can now filter which topics are included based on their subject.
 */
async function loadAndMapLabels(labelFilterSubjects = []) {
    return new Promise((resolve, reject) => {
        const topicMap = new Map();
        const topicsForLLM = [];
        const lowerCaseFilter = labelFilterSubjects.map(s => s.toLowerCase());

        fs.createReadStream(path.join(__dirname, INPUT_FILE_LABELS)).pipe(csv())
            .on('data', (row) => {
                // The full topicMap is always created for reliable lookup later.
                topicMap.set(row.Topic, { subject: row.Subject, category: row.Category });

                const shouldInclude = lowerCaseFilter.length === 0 || lowerCaseFilter.includes(row.Subject.toLowerCase());
                if (shouldInclude) {
                    // Create a structured object for the LLM prompt
                    topicsForLLM.push({
                        Topic: row.Topic,
                        Terms: row.Terms || "" // Ensure Terms is at least an empty string
                    });
                }
            })
            .on('end', () => {
                const topicsWithTermsJsonString = JSON.stringify(topicsForLLM, null, 2);
                console.log(`Providing ${topicsForLLM.length} topics (with terms) to the LLM based on the filter.`);
                resolve({ topicMap, topicsWithTermsJsonString });
            })
            .on('error', reject);
    });
}

/**
 * Makes a direct API call to the OpenAI API, sanitizing parameters.
 */
async function callOpenAI(trace, promptMessages, model, modelParameters) {
    if (!openai) throw new Error("OpenAI client not initialized.");
    const { generationConfig, ...openAIParams } = modelParameters; // Sanitize params
    const generation = trace.generation({ name: 'openai-direct-call', input: promptMessages, model, modelParameters: openAIParams });
    try {
        const completion = await openai.chat.completions.create({ model, messages: promptMessages, ...openAIParams });
        const output = completion.choices[0].message.content;
        generation.end({ output });
        return output;
    } catch (error) {
        generation.end({ level: "ERROR", statusMessage: error.message });
        throw error;
    }
}

/**
 * Makes a direct API call to the Google GenAI API, normalizing parameters.
 */
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

/**
 * Corrects the structure of Google's model parameters to ensure reliability.
 */
function normalizeGoogleParams(params) {
    if (!params) return {};
    const normalized = { generationConfig: { ...(params.generationConfig || {}) } };
    for (const key in params) {
        if (Object.prototype.hasOwnProperty.call(params, key) && key !== 'generationConfig') {
            normalized.generationConfig[key] = params[key];
        }
    }
    if (!normalized.generationConfig.response_mime_type) {
        normalized.generationConfig.response_mime_type = "application/json";
    }
    return normalized;
}


// --- Main Application Logic ---
app.post('/label-targets', async (req, res) => {
    const startTime = Date.now();
    let modelName;
    try {
        const filterSubjects = req.body.Subject || [];
        const filterTargetIDs = new Set(req.body.Target_IDs || []);
        const labelFilterSubjects = req.body.Use_labels || [];

        if (filterSubjects.length > 0) {
            console.log(`Request received. Filtering targets to process from subjects: [${filterSubjects.join(', ')}]`);
        }
        if (labelFilterSubjects.length > 0) {
            console.log(`Request received. Filtering available labels to use from subjects: [${labelFilterSubjects.join(', ')}]`);
        }
        if (filterTargetIDs.size > 0) {
            console.log(`Request received. Filtering for ${filterTargetIDs.size} specific Target_IDs.`);
        }
        if (filterSubjects.length === 0 && filterTargetIDs.size === 0) {
            console.log("Request received. No target filters applied, processing all targets.");
        }

        const pLimit = (await import('p-limit')).default;
        const concurrency = parseInt(process.env.CONCURRENCY_LIMIT) || 15;
        const limit = pLimit(concurrency);
        console.log(`Using concurrency limit: ${concurrency}`);

        const { topicMap, topicsWithTermsJsonString } = await loadAndMapLabels(labelFilterSubjects);
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
                let hasMatchingSubject = filterSubjects.length === 0 || (target.subject && (Array.isArray(target.subject) ? target.subject.some(s => filterSubjects.includes(s)) : filterSubjects.includes(target.subject)));
                const hasMatchingID = filterTargetIDs.size === 0 || filterTargetIDs.has(target.id);
                const shouldProcess = hasMatchingSubject && hasMatchingID;

                if (shouldProcess) {
                    processedCount++;
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
                                topics_with_terms_json: topicsWithTermsJsonString
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
                            
                            const rankedTopics = llmResponse.RankedTopics || [];
                            const llmTopics = rankedTopics.map(item => item.Topic);
                            const topConfidence = rankedTopics.length > 0 ? rankedTopics[0].Confidence : 0;

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

                            trace.update({ input: promptInput, output: llmResponse });

                            return { 
                                ...simplifiedTarget, 
                                Subject: Array.from(subjects),
                                Category: Array.from(categories),
                                Topic: llmTopics,
                                Confidence: topConfidence
                            };
                        } catch (error) {
                            console.error(`--- ERROR PROCESSING TARGET ID: ${simplifiedTarget.Target_ID} ---`);
                            console.error(`Error Message: ${error.message}`);
                            trace.update({ level: 'ERROR', statusMessage: error.message });
                            return { ...simplifiedTarget, Subject: ['Error processing'], Category: ['Error processing'], Topic: ['Error processing'], Confidence: -1 };
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