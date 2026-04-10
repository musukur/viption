import express from "express";
import { spawn } from "child_process";

const app = express();

app.use(express.json());

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

app.get("/health", async (req, res) => {
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
