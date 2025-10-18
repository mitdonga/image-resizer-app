// server.js (ESM)
import express from "express";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create images directory if it doesn't exist
const imagesDir = path.join(__dirname, "images");
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Serve images from the images directory
app.use("/images", express.static(imagesDir));

/**
 * Helper: convert background query param to sharp background object.
 * Accepts: "white" / "transparent" / "#RRGGBB" or "rgb(r,g,b)".
 */
function parseBackground(bgParam) {
  if (!bgParam) return { r: 255, g: 255, b: 255, alpha: 1 }; // default white
  if (bgParam.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, alpha: 0 };
  // hex e.g. #ffffff or ffffff
  const hex = bgParam.replace("#", "");
  if (/^[0-9A-Fa-f]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return { r, g, b, alpha: 1 };
  }
  // fallback white
  return { r: 255, g: 255, b: 255, alpha: 1 };
}

/**
 * POST /resize
 * form-data:
 *   image: file
 * query params (optional):
 *   size (default 3000) -- integer
 *   bg (default "white") -- "white", "transparent", or "#RRGGBB"
 *
 * Response: JSON object with filename, location, and other metadata
 * Saves resized image to /images/ directory
 */
app.post("/resize", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: "Missing file field 'image'",
        success: false 
      });
    }

    const size = Math.max(1, parseInt(req.query.size || "3000", 10));
    const bgParam = req.query.bg || "white";
    const background = parseBackground(bgParam);

    // read input buffer and metadata
    const inputBuffer = req.file.buffer;
    const metadata = await sharp(inputBuffer).metadata();

    // choose output format:
    // - If user asked for transparent background, output PNG (supports alpha)
    // - Otherwise: if input has alpha, keep PNG; else output JPEG for smaller size
    let outputFormat = "jpeg";
    if (background.alpha === 0) outputFormat = "png";
    else if (metadata.hasAlpha) outputFormat = "png";
    else {
      // keep jpeg if original was jpeg; else jpeg is fine
      if ((req.file.mimetype || "").includes("png")) outputFormat = "png";
      else outputFormat = "jpeg";
    }

    // Sharp pipeline: resize to bounding box size×size, keep aspect ratio, center, pad with background
    // use fit: 'contain' to scale image to fit within the box and leave background padding.
    const pipeline = sharp(inputBuffer)
      .resize({
        width: size,
        height: size,
        fit: "contain",
        background: background,
      });

    // set output format and options
    if (outputFormat === "png") {
      pipeline.png({ compressionLevel: 9 });
    } else {
      pipeline.jpeg({ quality: 90 });
    }

    const outBuffer = await pipeline.toBuffer();

    // Generate unique filename with timestamp
    const originalName = path.parse(req.file.originalname).name;
    const timestamp = Date.now();
    const filename = `${originalName}_resized_${timestamp}.${outputFormat}`;
    const filePath = path.join(imagesDir, filename);

    // Save file to images directory
    fs.writeFileSync(filePath, outBuffer);

    // Return JSON response with location and filename
    res.json({
      success: true,
      filename: filename,
      location: `/images/${filename}`,
      absolutePath: filePath,
      size: `${size}x${size}`,
      format: outputFormat,
      background: bgParam
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ 
      error: "Processing error: " + (err && err.message),
      success: false 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Image resize server running at http://localhost:${PORT}`);
  console.log(`POST /resize with form-data field 'image'`);
});
