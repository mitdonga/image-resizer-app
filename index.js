// server.js (ESM)
import express from "express";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import fetch from "node-fetch";

// Load environment variables
dotenv.config();

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const uploadMultiple = multer({ 
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 5 // Maximum 5 files
  },
  fileFilter: (req, file, cb) => {
    // Check file type
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Middleware to parse JSON bodies
app.use(express.json());

// Bearer authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ 
      error: 'Access token required. Please provide Bearer token in Authorization header.',
      success: false 
    });
  }

  if (token !== process.env.AUTH_TOKEN) {
    return res.status(403).json({ 
      error: 'Invalid access token.',
      success: false 
    });
  }

  next();
}

// Serve static files (HTML, CSS, JS)
app.use(express.static('.'));

/**
 * GET / - Serve the home page
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'home.html'));
});

/**
 * GET /multiple - Serve the multiple image resizer page
 */
app.get('/multiple', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'multiple.html'));
});

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

async function uploadToS3(buffer, filename, contentType) {
  const folderPrefix = process.env.S3_FOLDER_PREFIX || "";
  const key = `${folderPrefix}${filename}`;
  
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  await s3Client.send(command);
  
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

/**
 * Helper: download image from URL and return buffer
 */
async function downloadImageFromUrl(imageUrl) {
  try {
    const response = await fetch(imageUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
    }
    
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
      throw new Error('URL does not point to a valid image');
    }
    
    const buffer = await response.buffer();
    return {
      buffer,
      contentType,
      originalname: path.basename(new URL(imageUrl).pathname) || 'downloaded_image'
    };
  } catch (error) {
    throw new Error(`Error downloading image from URL: ${error.message}`);
  }
}

/**
 * POST /resize
 * Accepts either:
 *   - form-data with 'image' field (file upload)
 *   - JSON body with 'image_url' field (URL to download)
 * Exactly one of these must be provided.
 * 
 * query params (optional):
 *   size (default 3000) -- integer
 *   bg (default "white") -- "white", "transparent", or "#RRGGBB"
 *
 * body params (optional):
 *   save_to_s3 (default false) -- boolean, if true saves to S3 and returns JSON, if false returns image file directly
 *
 * Response: 
 *   - If save_to_s3=true: JSON object with filename, S3 URL, and other metadata
 *   - If save_to_s3=false: Direct image file download
 */
app.post("/resize", authenticateToken, upload.single("image"), async (req, res) => {
  try {
    const imageUrl = req.body?.image_url;
    const hasFile = !!req.file;
    const hasUrl = !!imageUrl;

    // Validate that exactly one input method is provided
    if (!hasFile && !hasUrl) {
      return res.status(400).json({ 
        error: "Either 'image' file field or 'image_url' JSON field must be provided",
        success: false 
      });
    }

    if (hasFile && hasUrl) {
      return res.status(400).json({ 
        error: "Provide either 'image' file field OR 'image_url' JSON field, not both",
        success: false 
      });
    }

    let inputBuffer, originalname, mimetype;

    if (hasFile) {
      // Handle file upload
      inputBuffer = req.file.buffer;
      originalname = req.file.originalname;
      mimetype = req.file.mimetype;
    } else {
      // Handle URL download
      const downloadedData = await downloadImageFromUrl(imageUrl);
      inputBuffer = downloadedData.buffer;
      originalname = downloadedData.originalname;
      mimetype = downloadedData.contentType;
    }

    const size = Math.max(1, parseInt(req.query.size || "3000", 10));
    const bgParam = req.query.bg || "white";
    const background = parseBackground(bgParam);

    // read input buffer and metadata
    const metadata = await sharp(inputBuffer).metadata();

    // Check if save_to_s3 attribute is provided
    const saveToS3 = req.query?.save_to_s3 === 'true' || req.query?.save_to_s3 === true;

    // choose output format:
    // - If user asked for transparent background, output PNG (supports alpha)
    // - Otherwise: if input has alpha, keep PNG; else output JPEG for smaller size
    let outputFormat = "jpeg";
    if (background.alpha === 0) outputFormat = "png";
    else if (metadata.hasAlpha) outputFormat = "png";
    else {
      // keep jpeg if original was jpeg; else jpeg is fine
      if ((mimetype || "").includes("png")) outputFormat = "png";
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
    const originalName = path.parse(originalname).name;
    // Replace special characters with underscores
    const sanitizedName = originalName.replace(/[()[\]+\s\-\.]/g, '_');
    const timestamp = Date.now();
    const filename = `${sanitizedName}_resized_${timestamp}.${outputFormat}`;

    if (saveToS3) {
      // Upload to S3
      const contentType = outputFormat === "png" ? "image/png" : "image/jpeg";
      const s3Url = await uploadToS3(outBuffer, filename, contentType);

      // Return JSON response with S3 URL and metadata
      res.json({
        success: true,
        filename: filename,
        url: s3Url,
        size: `${size}x${size}`,
        format: outputFormat,
        background: bgParam,
        source: hasFile ? "file" : "url",
        saved_to_s3: true
      });
    } else {
      // Return the resized image file directly
      const contentType = outputFormat === "png" ? "image/png" : "image/jpeg";
      
      res.set({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': outBuffer.length
      });
      
      res.send(outBuffer);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ 
      error: "Processing error: " + (err && err.message),
      success: false 
    });
  }
});

/**
 * POST /resize-multiple
 * Accepts multiple image files (up to 5) via form-data
 * 
 * query params:
 *   size (default 3000) -- integer
 *   bg (default "white") -- "white", "transparent", or "#RRGGBB"
 *
 * Response: JSON object with array of processed images (base64 encoded)
 * Does NOT save to S3 - returns images directly to client
 */
app.post("/resize-multiple", authenticateToken, uploadMultiple.array("images", 5), async (req, res) => {
  try {
    const files = req.files;
    
    // Validate that at least one file is provided
    if (!files || files.length === 0) {
      return res.status(400).json({ 
        error: "At least one image file must be provided",
        success: false 
      });
    }

    // Validate file count
    if (files.length > 5) {
      return res.status(400).json({ 
        error: "Maximum 5 images allowed per request",
        success: false 
      });
    }

    const size = Math.max(1, parseInt(req.query.size || "3000", 10));
    const bgParam = req.query.bg || "white";
    const background = parseBackground(bgParam);

    // Process all images in parallel
    const processImage = async (file, index) => {
      try {
        const inputBuffer = file.buffer;
        const originalname = file.originalname;
        const mimetype = file.mimetype;

        // Read input buffer and metadata
        const metadata = await sharp(inputBuffer).metadata();

        // Choose output format
        let outputFormat = "jpeg";
        if (background.alpha === 0) outputFormat = "png";
        else if (metadata.hasAlpha) outputFormat = "png";
        else {
          if ((mimetype || "").includes("png")) outputFormat = "png";
          else outputFormat = "jpeg";
        }

        // Sharp pipeline: resize to bounding box size×size, keep aspect ratio, center, pad with background
        const pipeline = sharp(inputBuffer)
          .resize({
            width: size,
            height: size,
            fit: "contain",
            background: background,
          });

        // Set output format and options
        if (outputFormat === "png") {
          pipeline.png({ compressionLevel: 9 });
        } else {
          pipeline.jpeg({ quality: 90 });
        }

        const outBuffer = await pipeline.toBuffer();
        
        // Convert to base64
        const base64 = outBuffer.toString('base64');
        const dataUrl = `data:image/${outputFormat};base64,${base64}`;

        // Generate filename
        const originalName = path.parse(originalname).name;
        const sanitizedName = originalName.replace(/[()[\]+\s\-\.]/g, '_');
        const timestamp = Date.now();
        const filename = `${sanitizedName}_resized_${timestamp}.${outputFormat}`;

        return {
          success: true,
          filename: filename,
          base64: dataUrl,
          size: `${size}x${size}`,
          format: outputFormat,
          originalSize: `${metadata.width}x${metadata.height}`,
          originalName: originalname,
          index: index
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          originalName: file.originalname,
          index: index
        };
      }
    };

    // Process all images in parallel
    const results = await Promise.all(files.map((file, index) => processImage(file, index)));

    // Separate successful and failed results
    const successful = results.filter(result => result.success);
    const failed = results.filter(result => !result.success);

    // Return response
    res.json({
      success: true,
      totalImages: files.length,
      successfulCount: successful.length,
      failedCount: failed.length,
      images: successful,
      errors: failed,
      settings: {
        size: `${size}x${size}`,
        background: bgParam
      }
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
});
