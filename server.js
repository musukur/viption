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

/* ============================= */
/* ===== COMMON UTIL ========= */
/* ============================= */

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);

    let stderr = "";

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr));
    });
  });
}

async function downloadFile(url, outputPath) {
  const response = await axios.get(url, { responseType: "stream" });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

/* ============================= */
/* ===== DURATION LOGIC ===== */
/* ============================= */

function distributeDurations(totalDurationMs, count) {
  const totalSec = totalDurationMs / 1000;

  if (count === 1) return [totalSec];

  const first = Math.min(2.5, totalSec * 0.2);
  const remaining = totalSec - first;

  const rest = Array(count - 1).fill(remaining / (count - 1));

  return [first, ...rest];
}

function normalizeDurations(durations, totalSec) {
  const sum = durations.reduce((a, b) => a + b, 0);
  const factor = totalSec / sum;
  return durations.map(d => d * factor);
}

/* ============================= */
/* ===== CINEMATIC MOTION ===== */
/* ============================= */

function getMotionFilter(index, width, height, durationSec, fps) {
  const frames = Math.floor(durationSec * fps);
  const variant = index % 4;

  switch (variant) {

    case 0:
      return `zoompan=z='1+0.15*(on/${frames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;

    case 1:
      return `zoompan=z='1.15':x='(on/${frames})*(iw-iw/zoom)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;

    case 2:
      return `zoompan=z='1.15':x='(iw-iw/zoom)-(on/${frames})*(iw-iw/zoom)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;

    default:
      return `zoompan=z='1.15-0.15*(on/${frames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;
  }
}

/* ============================= */
/* ===== IMAGE -> VIDEO ===== */
/* ============================= */

async function createImageClip({
  imagePath,
  clipPath,
  durationSec,
  index,
  width,
  height,
  fps = 25
}) {

  const frames = Math.floor(durationSec * fps);

  const motion = getMotionFilter(index, width, height, durationSec, fps);

  const vf = [
    `scale=${width * 1.2}:-1`,
    motion,
    `format=yuv420p`
  ].join(",");

  await runCommand("ffmpeg", [
    "-y",
    "-loop", "1",
    "-i", imagePath,

    // ❗ REMOVE -t ❌
    // "-t", String(durationSec),

    "-vf", vf,

    // ❗ IMPORTANT
    "-frames:v", String(frames),

    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "28",

    clipPath
  ]);
}

/* ============================= */
/* ===== TRANSITION MERGE ===== */
/* ============================= */

async function mergeWithTransitions(clips, durations, outputPath, fps) {
  const inputs = [];
  clips.forEach(c => inputs.push("-i", c));

  let filter = "";
  let last = "[0:v]";
  let cumulative = 0;

  for (let i = 1; i < clips.length; i++) {
    const t = 0.6;
    cumulative += durations[i - 1];
    const offset = cumulative - t;

    filter += `${last}[${i}:v]xfade=transition=fade:duration=${t}:offset=${offset}[v${i}];`;
    last = `[v${i}]`;
  }

  await runCommand("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", filter,
    "-map", last,
    "-r", String(fps),
    "-c:v", "libx264",
    "-crf", "20",
    outputPath
  ]);
}

/* ============================= */
/* ===== VIDEO ENDPOINT ===== */
/* ============================= */

app.post("/render/video", async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(TMP_DIR, jobId);

  try {
    const { audioUrl, totalDurationMs, images } = req.body;

    if (!audioUrl || !totalDurationMs || !images?.length) {
      throw new Error("Invalid input");
    }

    await fs.ensureDir(workDir);

    const width = 1920;
    const height = 1080;
    const fps = 25;

    const audioPath = path.join(workDir, "audio.mp3");
    await downloadFile(audioUrl, audioPath);

    let durations = distributeDurations(totalDurationMs, images.length);
    durations = normalizeDurations(durations, totalDurationMs / 1000);

    const clipPaths = [];

    for (let i = 0; i < images.length; i++) {
      const imagePath = path.join(workDir, `img_${i}.jpg`);
      const clipPath = path.join(workDir, `clip_${i}.mp4`);

      await downloadFile(images[i].url, imagePath);

      await createImageClip({
        imagePath,
        clipPath,
        durationSec: durations[i],
        index: i,
        width,
        height,
        fps
      });

      clipPaths.push(clipPath);
    }

    const mergedPath = path.join(workDir, "merged.mp4");

    const concatFilePath = path.join(workDir, "files.txt");

    const content = clipPaths.map(p => `file '${p}'`).join("\n");
    
    await fs.writeFile(concatFilePath, content);
    
    await runCommand("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatFilePath,
      "-c", "copy",
      mergedPath
    ]);

    const finalPath = path.join(workDir, "final.mp4");

    await runCommand("ffmpeg", [
      "-y",
      "-i", mergedPath,
      "-i", audioPath,
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      finalPath
    ]);

    res.setHeader("Content-Type", "video/mp4");
    fs.createReadStream(finalPath).pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================= */
/* ===== HEALTH ===== */
/* ============================= */

app.get("/health", async (_req, res) => {
  try {
    await runCommand("ffmpeg", ["-version"]);
    res.json({ status: "ok" });
  } catch {
    res.status(500).json({ status: "ffmpeg not working" });
  }
});

/* ============================= */
/* ===== ASS SUBTITLE (UNCHANGED) */
/* ============================= */

app.post("/render-ass", async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(TMP_DIR, jobId);

  try {
    const { videoUrl, assContent } = req.body;

    const input = path.join(workDir, "input.mp4");
    const output = path.join(workDir, "output.mp4");
    const subtitle = path.join(workDir, "sub.ass");

    await fs.ensureDir(workDir);

    await downloadFile(videoUrl, input);
    await fs.writeFile(subtitle, assContent);

    await runCommand("ffmpeg", [
      "-y",
      "-i", input,
      "-vf", `ass=${subtitle}`,
      "-c:a", "copy",
      output
    ]);

    res.setHeader("Content-Type", "video/mp4");
    fs.createReadStream(output).pipe(res);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
