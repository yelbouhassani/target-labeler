
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config(); // To read the GOOGLE_API_KEY from .env

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  throw new Error("GOOGLE_API_KEY is not set in your .env file.");
}

const genAI = new GoogleGenerativeAI(apiKey);

async function runTest() {
  try {
    console.log("Attempting to connect to Google API...");

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

    const prompt = "What are the three most popular programming languages? Respond in valid JSON like {\"languages\": [\"lang1\", \"lang2\", \"lang3\"]}.";

    console.log("Sending a test prompt to the model...");
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    console.log("--- SUCCESS! ---");
    console.log("Received a valid response from the Google API:");
    console.log(text);
    console.log("\nThis confirms your API Key, Billing, and Permissions are all CORRECT.");

  } catch (error) {
    console.error("--- TEST FAILED! ---");
    console.error("The direct call to Google's API failed. This is the root cause of your problem.");
    console.error("The error message from Google is:");
    console.error(error);
  }
}

runTest();