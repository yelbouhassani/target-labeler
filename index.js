// index.js (Updated with Postman Filtering and Topic in Output)

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Langfuse } = require('langfuse');
const JSONStream = require('jsonstream');
require('dotenv').config();

const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;
const INPUT_FILE_TARGETS = 'all_targets.json';
const INPUT_FILE_LABELS = 'labels.json';
const OUTPUT_FILE = 'labeled_targets.json';
const PROMPT_NAME = 'target-labeler';

// --- NEW: Enable Express to parse JSON bodies from requests ---
app.use(express.json());

const langfuse = new Langfuse();
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
if (openai) console.log("OpenAI client initialized.");
const googleGenAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;
if (googleGenAI) console.log("Google GenAI client initialized.");


// --- Helper Functions (unchanged) ---
function formatLabels(labels) { /* ... same as before ... */ }
function normalizeGoogleParams(params) { /* ... same as before ... */ }
async function callOpenAI(trace, promptMessages, model, modelParameters) { /* ... same as before ... */ }
async function callGoogle(trace, promptString, model, modelParameters) { /* ... same as before ... */ }


// --- Main Application Logic ---
app.post('/label-targets', async (req, res) => {
    // --- NEW: Extract filter topics from the request body ---
    const filterTopics = req.body.Topic || []; // Default to an empty array if not provided

    if (filterTopics.length > 0) {
        console.log(`Received request to label targets. Filtering for topics: [${filterTopics.join(', ')}]`);
    } else {
        console.log("Received request to label targets. No topic filter applied, processing all targets.");
    }
    
    try {
        const labelsRawData = fs.readFileSync(path.join(__dirname, INPUT_FILE_LABELS), 'utf-8');
        const availableLabels = JSON.parse(labelsRawData);
        const formattedLabelsString = formatLabels(availableLabels);

        const promptTemplate = await langfuse.getPrompt(PROMPT_NAME);
        const provider = promptTemplate.config.provider;
        const modelName = promptTemplate.config.model || promptTemplate.config.modelName;
        console.log(`Configurations loaded. Dispatching to provider: ${provider}, Model: ${modelName}.`);

        const labeledTargets = await new Promise((resolve, reject) => {
            const labelingPromises = [];
            let targetCount = 0;
            let processedCount = 0;
            const stream = fs.createReadStream(path.join(__dirname, INPUT_FILE_TARGETS), { encoding: 'utf8' });
            const parser = JSONStream.parse('data.search_results.targets.*');
            stream.pipe(parser);

            parser.on('data', (target) => {
                targetCount++;

                // --- NEW: Apply the filtering logic ---
                const hasMatchingTopic = filterTopics.length === 0 || target.topic?.some(t => filterTopics.includes(t));

                if (hasMatchingTopic) {
                    processedCount++;
                    const labelingPromise = (async () => {
                        // --- NEW: Add original topic to the simplified target object ---
                        const simplifiedTarget = {
                            Target_ID: target.id,
                            Label: target.label,
                            Description: target.description,
                            Explanation: target.target_explanation,
                            Subject: target.topic // Add the original topic here
                        };
                        const experimentalText = "---*Deze uitleg is experimenteel en wordt nog verder verbeterd.*";
                        if (simplifiedTarget.Explanation) {
                            simplifiedTarget.Explanation = simplifiedTarget.Explanation.replace(experimentalText, '').trim();
                        }
                    
                        const trace = langfuse.trace({ name: 'target-labeling-trace', metadata: { targetId: simplifiedTarget.Target_ID } });
                        try {
                            let llmCompletion;
                            const promptInput = {
                                label: simplifiedTarget.Label, description: simplifiedTarget.Description,
                                explanation: simplifiedTarget.Explanation, available_labels: formattedLabelsString
                            };
                            const compiledPrompt = promptTemplate.compile(promptInput);

                            if (provider === 'OPENAI') {
                                llmCompletion = await callOpenAI(trace, compiledPrompt, modelName, promptTemplate.config.modelParameters);
                            } else if (provider === 'GOOGLE_GENAI') {
                                const promptString = compiledPrompt.map(m => `${m.role}: ${m.content}`).join('\n\n');
                                llmCompletion = await callGoogle(trace, promptString, modelName, promptTemplate.config.modelParameters);
                            } else {
                                throw new Error(`Unsupported provider: ${provider}`);
                            }

                            if (!llmCompletion) { throw new Error('Direct API call returned an empty completion.'); }
                            
                            const jsonMatch = llmCompletion.match(/\{[\s\S]*\}/);
                            if (!jsonMatch) { throw new Error("Could not find a valid JSON object in the LLM's response."); }
                            const jsonString = jsonMatch[0];
                            const llmResponse = JSON.parse(jsonString);
                            trace.update({ input: promptInput, output: llmResponse });
                            return { ...simplifiedTarget, Topic: llmResponse.Topic || [], Category: llmResponse.Category || [] };
                        } catch (error) {
                            console.error(`--- ERROR PROCESSING TARGET ID: ${simplifiedTarget.Target_ID} ---`);
                            console.error(`Error Message: ${error.message}`);
                            return { ...simplifiedTarget, Category: ['Error processing'], Topic: ['Error processing'] };
                        }
                    })();
                    labelingPromises.push(labelingPromise);
                }
            });

            parser.on('end', async () => {
                console.log(`Finished reading file. Scanned ${targetCount} targets, processing ${processedCount}. Waiting for all API calls to complete...`);
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
        res.status(200).json({ message: "Processing complete.", data: labeledTargets });
    } catch (error) {
        console.error("An unexpected error occurred in the main process:", error);
        res.status(500).json({ error: "An internal server error occurred.", details: error.message });
    }
});

app.listen(PORT, () => console.log(`Server is running on http://localhost:${PORT}`));


// --- Full Helper Function Implementations ---
function formatLabels(labels) { const grouped = labels.reduce((acc, { Category, Topic }) => { if (!acc[Category]) { acc[Category] = []; } acc[Category].push(Topic); return acc; }, {}); return Object.entries(grouped).map(([category, topics]) => `*   **Category: ${category}**\n    *   Topics: ${topics.join(', ')}`).join('\n\n'); }
function normalizeGoogleParams(params) { if (!params) return {}; const normalized = { generationConfig: { ...(params.generationConfig || {}) } }; for (const key in params) { if (Object.prototype.hasOwnProperty.call(params, key) && key !== 'generationConfig') { normalized.generationConfig[key] = params[key]; } } return normalized; }
async function callOpenAI(trace, promptMessages, model, modelParameters) { if (!openai) throw new Error("OpenAI client not initialized."); const generation = trace.generation({ name: 'openai-direct-call', input: promptMessages, model, modelParameters }); try { const completion = await openai.chat.completions.create({ model, messages: promptMessages, ...modelParameters }); const output = completion.choices[0].message.content; generation.end({ output }); return output; } catch (error) { generation.end({ level: "ERROR", statusMessage: error.message }); throw error; } }
async function callGoogle(trace, promptString, model, modelParameters) { if (!googleGenAI) throw new Error("Google client not initialized."); const googleModel = googleGenAI.getGenerativeModel({ model }); const correctedParams = normalizeGoogleParams(modelParameters); const generation = trace.generation({ name: 'google-direct-call', input: promptString, model, modelParameters: correctedParams }); try { const result = await googleModel.generateContent(promptString, correctedParams.generationConfig); const output = result.response.text(); generation.end({ output }); return output; } catch (error) { generation.end({ level: "ERROR", statusMessage: error.message }); throw error; } }