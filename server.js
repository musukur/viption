import express from "express";
import axios from "axios";
import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "20mb" }));

const TMP_DIR = path.join(__dirname, "tmp");
await fs.ensureDir(TMP_DIR);

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} failed with code ${code}\n${stderr}`));
      }
    });

    child.on("error", (err) => reject(err));
  });
}

async function downloadFile(url, outputPath) {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 120000,
    maxRedirects: 5
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

app.get("/health", async (_req, res) => {
  try {
    const result = await runCommand("ffmpeg", ["-version"]);

    res.json({
      status: "ok",
      message: "API is working",
      ffmpeg: result.stdout.split("\n")[0]
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "FFmpeg not available",
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
