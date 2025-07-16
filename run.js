// Import the 'fs' (file system) module to read files.
// We use the 'promises' version for modern async/await syntax.
const fs = require('fs').promises;

// Import our search function from the other file.
const { findTargetIdsByExplanation } = require('./search.js');

// The main function to run our script logic.
async function main() {
  try {
    // 1. Read the JSON file from the disk. 'utf8' is the encoding.
    const fileContent = await fs.readFile('all_targets.json', 'utf8');
    
    // 2. Parse the file content (which is a string) into a JavaScript object.
    const jsonData = JSON.parse(fileContent);

    // --- Define your conditions here ---

    // Condition A: Find targets where 'target_explanation' is exactly null.
    const isNullCondition = (explanation) => explanation === null;
    const nullIds = findTargetIdsByExplanation(jsonData, isNullCondition);
    console.log("IDs where target_explanation is null:", nullIds); // Expected: ["1458"]

    // // Condition B: Find targets where 'target_explanation' contains "Galilei".
    // const containsGalilei = (explanation) => {
    //     // We must check if explanation is a string before calling .includes()
    //     return typeof explanation === 'string' && explanation.includes('Galilei');
    // };
    // const galileiIds = findTargetIdsByExplanation(jsonData, containsGalilei);
    // console.log("IDs mentioning 'Galilei':", galileiIds); // Expected: ["1456"]

  } catch (error) {
    console.error("An error occurred:", error.message);
  }
}

// Run the main function.
main();