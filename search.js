/**
 * Searches targets in the JSON data and returns the IDs of those that match a condition.
 * This function is exported so it can be used by other files.
 *
 * @param {object} data - The full JSON data object.
 * @param {function(string | null): boolean} conditionCallback - A function that takes the 'target_explanation'
 * and returns true if it meets the condition, otherwise false.
 * @returns {string[]} An array of target IDs that matched the condition.
 */
function findTargetIdsByExplanation(data, conditionCallback) {
  // Safely access the nested 'targets' array.
  const targets = data?.data?.search_results?.targets;

  // If targets is not an array or is empty, return an empty array.
  if (!Array.isArray(targets)) {
    console.error("Could not find a 'targets' array in the provided data.");
    return [];
  }

  // 1. Filter the targets array based on the condition
  const matchingTargets = targets.filter(target => {
    // Check if the target object exists and has the 'target_explanation' property.
    // This allows us to correctly check for `null` values, distinguishing them from a missing key.
    if (target && target.hasOwnProperty('target_explanation')) {
      return conditionCallback(target.target_explanation);
    }
    // If the condition is to find missing keys, the callback should handle it.
    // By default, we exclude targets where the key is missing.
    return false;
  });

  // 2. Map the filtered array to get only the 'id' of each target
  const targetIds = matchingTargets.map(target => target.id);

  return targetIds;
}

// In a Node.js environment, we export the function.
// For a browser, this line would be ignored or removed if not using modules.
module.exports = { findTargetIdsByExplanation };