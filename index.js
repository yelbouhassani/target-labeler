// index.js (Final Version with Direct API Calls)

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Langfuse } = require('langfuse');
const JSONStream = require('jsonstream');
require('dotenv').config();

// --- NEW: Import official provider libraries ---
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");

// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 3000;
const INPUT_FILE_TARGETS = 'all_targets.json';
const INPUT_FILE_LABELS = 'labels.json';
const OUTPUT_FILE = 'labeled_targets.json';
const PROMPT_NAME = 'target-labeler';

// --- Initialize ALL Clients ---
const langfuse = new Langfuse();

// Initialize OpenAI client
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
if (openai) console.log("OpenAI client initialized.");

// Initialize Google client
const googleGenAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;
if (googleGenAI) console.log("Google GenAI client initialized.");


// --- Helper Functions ---

function formatLabels(labels) {
    const grouped = labels.reduce((acc, { Category, Topic }) => {
        if (!acc[Category]) { acc[Category] = []; }
        acc[Category].push(Topic);
        return acc;
    }, {});
    return Object.entries(grouped)
        .map(([category, topics]) => `*   **Category: ${category}**\n    *   Topics: ${topics.join(', ')}`)
        .join('\n\n');
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

// --- NEW: Direct API Call Functions ---

async function callOpenAI(trace, promptMessages, model, modelParameters) {
    if (!openai) throw new Error("OpenAI client not initialized. Check your OPENAI_API_KEY.");

    // Manually start a Langfuse generation span
    const generation = trace.generation({ name: 'openai-direct-call', input: promptMessages, model, modelParameters });
    try {
        const completion = await openai.chat.completions.create({
            model: model,
            messages: promptMessages,
            ...modelParameters // Spread the parameters (temperature, response_format, etc.)
        });
        const output = completion.choices[0].message.content;
        generation.end({ output }); // Manually end the span with the successful output
        return output;
    } catch (error) {
        generation.end({ level: "ERROR", statusMessage: error.message }); // End the span with an error
        throw error; // Re-throw the error so the main loop can catch it
    }
}

async function callGoogle(trace, promptString, model, modelParameters) {
    if (!googleGenAI) throw new Error("Google client not initialized. Check your GOOGLE_API_KEY.");

    const googleModel = googleGenAI.getGenerativeModel({ model });
    const correctedParams = normalizeGoogleParams(modelParameters);

    // Manually start a Langfuse generation span
    const generation = trace.generation({ name: 'google-direct-call', input: promptString, model, modelParameters: correctedParams });
    try {
        const result = await googleModel.generateContent(promptString, correctedParams.generationConfig);
        const output = result.response.text();
        generation.end({ output }); // Manually end the span with the successful output
        return output;
    } catch (error) {
        generation.end({ level: "ERROR", statusMessage: error.message }); // End the span with an error
        throw error;
    }
}


// --- Main Application Logic ---

app.post('/label-targets', async (req, res) => {
    console.log("Received request to label targets via direct API calls...");
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
            const stream = fs.createReadStream(path.join(__dirname, INPUT_FILE_TARGETS), { encoding: 'utf8' });
            const parser = JSONStream.parse('data.search_results.targets.*');
            stream.pipe(parser);

            parser.on('data', (target) => {
                targetCount++;
                const simplifiedTarget = {
                    Target_ID: target.id,
                    Label: target.label,
                    Description: target.description,
                    Explanation: target.target_explanation,
                };
                const experimentalText = "---*Deze uitleg is experimenteel en wordt nog verder verbeterd.*";
                if (simplifiedTarget.Explanation) {
                    simplifiedTarget.Explanation = simplifiedTarget.Explanation.replace(experimentalText, '').trim();
                }
                
                const labelingPromise = (async () => {
                    const trace = langfuse.trace({ name: 'target-labeling-trace', metadata: { targetId: simplifiedTarget.Target_ID } });
                    try {
                        let llmCompletion;
                        const promptInput = {
                            label: simplifiedTarget.Label,
                            description: simplifiedTarget.Description,
                            explanation: simplifiedTarget.Explanation,
                            available_labels: formattedLabelsString
                        };
                        // langfuse.compile() returns a string for completion models or an array of messages for chat models.
                        const compiledPrompt = promptTemplate.compile(promptInput);

                        // --- DISPATCHER ---
                        if (provider === 'OPENAI') {
                            llmCompletion = await callOpenAI(trace, compiledPrompt, modelName, promptTemplate.config.modelParameters);
                        } else if (provider === 'GOOGLE_GENAI') {
                            // Google's current library works best with a single string prompt.
                            const promptString = compiledPrompt.map(m => `${m.role}: ${m.content}`).join('\n\n');
                            llmCompletion = await callGoogle(trace, promptString, modelName, promptTemplate.config.modelParameters);
                        } else {
                            throw new Error(`Unsupported provider configured in Langfuse: ${provider}`);
                        }

                        if (!llmCompletion) { throw new Error('Direct API call returned an empty completion.'); }

                        const llmResponse = JSON.parse(llmCompletion);
                        return { ...simplifiedTarget, Category: llmResponse.Category || [], Topic: llmResponse.Topic || [] };
                    } catch (error) {
                        console.error(`--- ERROR PROCESSING TARGET ID: ${simplifiedTarget.Target_ID} ---`);
                        console.error(`Error Message: ${error.message}`);
                        return { ...simplifiedTarget, Category: ['Error processing'], Topic: ['Error processing'] };
                    }
                })();
                labelingPromises.push(labelingPromise);
            });

            parser.on('end', async () => {
                console.log(`Finished reading file (${targetCount} targets). Waiting for all API calls to complete...`);
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