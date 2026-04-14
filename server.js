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
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} failed with code ${code} signal ${signal}\n${stderr}`
          )
        );
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

function mapPosition(position) {
  switch (position) {
    case "top":
      return 8;
    case "center":
      return 5;
    case "bottom":
    default:
      return 2;
  }
}

function hexToAssColor(hex) {
  const clean = (hex || "#FFFFFF").replace("#", "");
  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) {
    throw new Error(`Invalid color value: ${hex}`);
  }

  const r = clean.substring(0, 2);
  const g = clean.substring(2, 4);
  const b = clean.substring(4, 6);

  return `&H00${b}${g}${r}`.toUpperCase();
}

function buildStyleLine(inputStyle = {}) {
  const style = {
    font: "Arial",
    fontSize: 32,
    bold: true,
    textColor: "#FFFFFF",
    outlineColor: "#000000",
    outlineWidth: 4,
    shadow: 2,
    position: "bottom",
    marginBottom: 160,
    ...inputStyle
  };

  const primaryColour = hexToAssColor(style.textColor);
  const outlineColour = hexToAssColor(style.outlineColor);
  const boldValue = style.bold ? -1 : 0;
  const alignment = mapPosition(style.position);

  return `Style: Default,${style.font},${style.fontSize},${primaryColour},&H0000FFFF,${outlineColour},&H64000000,${boldValue},0,0,0,100,100,0,0,1,${style.outlineWidth},${style.shadow},${alignment},40,40,${style.marginBottom},1`;
}

function validateRenderRequest(body) {
  const { videoUrl, assContent, style } = body;

  if (!videoUrl || typeof videoUrl !== "string") {
    throw new Error("videoUrl is required and must be a string");
  }

  if (!assContent || typeof assContent !== "string") {
    throw new Error("assContent is required and must be a string");
  }

  if (!assContent.includes("Style: Default,")) {
    throw new Error("assContent must contain 'Style: Default,'");
  }

  if (!assContent.includes("[Events]")) {
    throw new Error("assContent must contain '[Events]'");
  }

  if (style !== undefined && (typeof style !== "object" || Array.isArray(style) || style === null)) {
    throw new Error("style must be an object");
  }

  if (style?.position && !["top", "center", "bottom"].includes(style.position)) {
    throw new Error("style.position must be one of: top, center, bottom");
  }
}

function getMotionFilter(index, width, height, fps, durationSec) {
  const frames = Math.max(1, Math.round(durationSec * fps));
  const variant = index % 4;

  switch (variant) {
    case 0:
      // stronger center push-in
      return `scale=3400:-1,zoompan=z='min(zoom+0.0016,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;

    case 1:
      // stronger left-focus push-in
      return `scale=3400:-1,zoompan=z='min(zoom+0.0016,1.5)':x='0':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;

    case 2:
      // stronger right-focus push-in
      return `scale=3400:-1,zoompan=z='min(zoom+0.0016,1.5)':x='iw-iw/zoom':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;

    default:
      // noticeable zoom-out
      return `scale=3400:-1,zoompan=z='if(lte(on,1),1.5,max(1.0,zoom-0.0016))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;
  }
}

async function createImageClip({
  imagePath,
  clipPath,
  durationSec,
  index,
  width = 1080,
  height = 1920,
  fps = 25
}) {
  const frames = Math.max(1, Math.round(durationSec * fps));

  const vf = getMotionFilter(index, width, height, fps, durationSec);

  await runCommand("ffmpeg", [
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-vf", vf,
    "-frames:v", String(frames),
    "-pix_fmt", "yuv420p",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "28",
    "-threads", "1",
    clipPath
  ]);
}

function applyStyleToAss(assContent, style = {}) {
  const newStyleLine = buildStyleLine(style);

  // normalize line endings first
  const normalized = assContent.replace(/\r\n/g, "\n");

  // try replacing any Style: Default line
  if (/^Style:\s*Default,/m.test(normalized)) {
    return normalized.replace(/^Style:\s*Default,.*$/m, newStyleLine);
  }

  // fallback: insert style line after the V4+ Styles format line
  if (/^\[V4\+ Styles\]$/m.test(normalized)) {
    return normalized.replace(
      /(\[V4\+ Styles\]\nFormat:.*\n)/m,
      `$1${newStyleLine}\n`
    );
  }

  throw new Error("Could not find ASS style section");
}

app.post("/render/video", async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(TMP_DIR, jobId);

  try {
    const { audioUrl, totalDurationMs, images } = req.body;

    if (!audioUrl || typeof audioUrl !== "string") {
      throw new Error("audioUrl is required and must be a string");
    }

    if (!totalDurationMs || typeof totalDurationMs !== "number") {
      throw new Error("totalDurationMs is required and must be a number");
    }

    if (!Array.isArray(images) || images.length === 0) {
      throw new Error("images is required and must be a non-empty array");
    }

    await fs.ensureDir(workDir);

    const width = 1080;
    const height = 1920;
    const fps = 25;

    const audioPath = path.join(workDir, "audio.mp3");
    await downloadFile(audioUrl, audioPath);

    const clipPaths = [];

    // 1. Download images + create cinematic clips
    for (let i = 0; i < images.length; i++) {
      const image = images[i];

      if (!image.url || typeof image.url !== "string") {
        throw new Error(`images[${i}].url is required`);
      }

      if (!image.duration || typeof image.duration !== "number") {
        throw new Error(`images[${i}].duration is required`);
      }

      const imagePath = path.join(workDir, `image_${i}.jpg`);
      const clipPath = path.join(workDir, `clip_${i}.mp4`);

      await downloadFile(image.url, imagePath);
      await createImageClip({
        imagePath,
        clipPath,
        durationSec: image.duration / 1000,
        index: i,
        width,
        height,
        fps
      });

      clipPaths.push(clipPath);
    }

    // 2. Build concat list
    const concatFilePath = path.join(workDir, "files.txt");
    const concatContent = clipPaths.map((clip) => `file '${clip}'`).join("\n");
    await fs.writeFile(concatFilePath, concatContent, "utf8");

    // 3. Merge clips
    const mergedPath = path.join(workDir, "merged.mp4");
    await runCommand("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatFilePath,
      "-c", "copy",
      mergedPath
    ]);

    // 4. Add audio
    const finalPath = path.join(workDir, "final.mp4");
    await runCommand("ffmpeg", [
      "-y",
      "-i", mergedPath,
      "-i", audioPath,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest",
      "-threads", "1",
      finalPath
    ]);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="video.mp4"');

    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);

    stream.on("close", async () => {
      await fs.remove(workDir).catch(() => {});
    });
  } catch (err) {
    await fs.remove(workDir).catch(() => {});

    res.status(500).json({
      success: false,
      error: "Video render failed",
      details: err.message
    });
  }
});

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

app.post("/render-ass", async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(TMP_DIR, jobId);
  const inputVideoPath = path.join(workDir, "input.mp4");
  const subtitlePath = path.join(workDir, "subtitles.ass");
  const outputVideoPath = path.join(workDir, "output.mp4");

  try {
    validateRenderRequest(req.body);

    const { videoUrl, assContent, style } = req.body;

    await fs.ensureDir(workDir);

    const updatedAssContent = applyStyleToAss(assContent, style || {});
    await fs.writeFile(subtitlePath, updatedAssContent, "utf8");

    await downloadFile(videoUrl, inputVideoPath);

    await runCommand("ffmpeg", [
      "-y",
      "-i",
      inputVideoPath,
      "-vf",
      `ass=${subtitlePath}`,
      "-c:a",
      "copy",
      outputVideoPath
    ]);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="output.mp4"');

    const stream = fs.createReadStream(outputVideoPath);
    stream.pipe(res);

    stream.on("close", async () => {
      await fs.remove(workDir).catch(() => {});
    });
  } catch (err) {
    await fs.remove(workDir).catch(() => {});

    res.status(500).json({
      success: false,
      error: "Video render failed",
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
