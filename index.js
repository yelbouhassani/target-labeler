// index.js

// Imports for server, file system, and Langfuse SDK
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Langfuse } = require('langfuse');
require('dotenv').config(); // Load environment variables from .env file

// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 3000;
const INPUT_FILE = 'all_targets.json';
const OUTPUT_FILE = 'labeled_targets.json';
const PROMPT_NAME = 'target-categorization'; // IMPORTANT: Must match the prompt name in Langfuse

// --- Langfuse Client Initialization ---
// The Langfuse SDK automatically picks up the keys from environment variables.
const langfuse = new Langfuse();

/**
 * @description Main endpoint to trigger the target labeling process.
 * It reads data, processes it in parallel with an LLM via Langfuse,
 * and saves the result.
 */
app.post('/label-targets', async (req, res) => {
    console.log("Received request to label targets...");

    try {
        // --- Step 1: Read and Process Data ---
        console.log(`Reading and transforming data from ${INPUT_FILE}...`);
        const rawData = fs.readFileSync(path.join(__dirname, INPUT_FILE), 'utf-8');
        const allTargetsData = JSON.parse(rawData);

        // Transform the nested structure into a simplified array
        const simplifiedTargets = allTargetsData.data.search_results.targets.map(target => ({
            Target_ID: target.id,
            Label: target.label,
            Description: target.description,
            Explanation: target.target_explanation,
        }));

        console.log(`Successfully transformed ${simplifiedTargets.length} targets.`);

        // --- Step 2: Compile Prompt (will happen inside the loop) ---
        console.log(`Fetching prompt template '${PROMPT_NAME}' from Langfuse...`);
        // We fetch the prompt template once before the loop
        const promptTemplate = await langfuse.getPrompt(PROMPT_NAME);
        console.log("Prompt template fetched successfully.");

        // --- Step 3 & 4: Send to LLM in Parallel and Process Responses ---
        console.log("Sending targets to LLM for labeling in parallel...");

        const labelingPromises = simplifiedTargets.map(async (target) => {
            // Create a Langfuse trace for each target to monitor it individually
            const trace = langfuse.trace({
                name: 'target-labeling-trace',
                userId: 'script-runner',
                metadata: { targetId: target.Target_ID }
            });

            try {
                // Compile the prompt with the specific target's data
                const compiledPrompt = promptTemplate.compile({
                    label: target.Label,
                    description: target.Description,
                    explanation: target.Explanation,
                });

                // The 'generation' call sends the request to the LLM configured in the Langfuse prompt
                const generation = await trace.generation({
                    name: 'llm-categorization',
                    prompt: promptTemplate,
                    input: {
                        label: target.Label,
                        description: target.Description,
                        explanation: target.Explanation,
                    },
                    model: promptTemplate.config.model, // Use model from prompt config
                    temperature: promptTemplate.config.temperature, // Use temp from prompt config
                });

                // Parse the LLM's JSON response
                const llmResponse = JSON.parse(generation.completion);

                // Merge the new labels with the existing target data
                return {
                    ...target,
                    Category: llmResponse.Category || [], // Default to empty array if key is missing
                    Topic: llmResponse.Topic || [],
                };
            } catch (error) {
                console.error(`Failed to process Target ID ${target.Target_ID}:`, error.message);
                // Return the original target with empty labels on failure
                return {
                    ...target,
                    Category: ['Error processing'],
                    Topic: ['Error processing'],
                };
            }
        });

        // Wait for all parallel requests to complete
        const labeledTargets = await Promise.all(labelingPromises);
        console.log("All targets have been processed.");

        // --- Step 5: Save Output ---
        console.log(`Saving labeled targets to ${OUTPUT_FILE}...`);
        fs.writeFileSync(path.join(__dirname, OUTPUT_FILE), JSON.stringify(labeledTargets, null, 2));
        console.log("Output file saved successfully.");

        // Also send the result as the API response
        res.status(200).json({
            message: `Successfully processed and labeled ${labeledTargets.length} targets.`,
            data: labeledTargets
        });

    } catch (error) {
        console.error("An unexpected error occurred:", error);
        res.status(500).json({ error: "An internal server error occurred.", details: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`To start, send a POST request to http://localhost:${PORT}/label-targets`);
});