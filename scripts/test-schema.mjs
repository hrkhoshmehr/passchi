import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ClassAnalysis } from "../src/analysis/schema.js";
const f = zodOutputFormat(ClassAnalysis);
console.log("keys:", Object.keys(f));
console.log("shape:", JSON.stringify(f).slice(0, 220));
