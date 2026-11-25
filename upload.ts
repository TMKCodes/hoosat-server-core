import { createReadStream, createWriteStream } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import { HoosatRequest, HoosatRequestHandler, HoosatResponse } from "./types";
import { DEBUG } from "./errors";
import { compressFiles } from "./compress";

/**
 * Makes a client provided file name safe to use as a file name on disk.
 * Strips any directory parts (both "/" and "\" separators) and unsafe characters,
 * so the file can never be written outside of the upload directory.
 *
 * @param {string | null | undefined} originalFilename - The file name sent by the client.
 * @returns {string} A safe file name.
 */
export const safeFilename = (originalFilename: string | null | undefined): string => {
  const baseName = path.posix.basename((originalFilename || "").replace(/\\/g, "/"));
  const cleaned = baseName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.slice(-200) || "file";
};

/**
 * middleware that handles file uploads and automatically compresses uploaded files.
 *
 * @function
 * @param {string} uploadLocation - The directory where uploaded files will be stored.
 * @param {number} _maxFileSize - The maximum allowed file size in bytes. Defaults to 10 MB.
 * @returns {HoosatRequestHandler} - A request handler function.
 */
export const upload = (uploadLocation: string, _maxFileSize: number = 10 * 1024 * 1024): HoosatRequestHandler => {
  return async (req: HoosatRequest, res: HoosatResponse, next?: HoosatRequestHandler) => {
    if (req.headers['content-type'] && req.headers['content-type'].startsWith('multipart/form-data')) {
      // Iterate over the keys in the request body
      for (const key in req.files) {
        const files = req.files[key];
        // Check if the value is an array (to handle multiple file uploads)
        if (Array.isArray(files)) {
          DEBUG.log(`Processing uploaded files for key "${key}"`);
          // Iterate over each uploaded file
          for (const file of files) {
            // Check if the file is successfully uploaded
            if (file.size > 0 && file.filepath) {
              const newFilename = `${randomUUID()}-${safeFilename(file.originalFilename)}`;
              const filePath = path.join(uploadLocation, newFilename);
              const writeStream = createWriteStream(filePath);
              // Pipe the file stream (writeStream) to the write stream to save the file
              const readStream = createReadStream(file.filepath);
              readStream.pipe(writeStream);
              file.filepath = filePath;
              file.newFilename = newFilename;
              // Log the file path
              DEBUG.log(`File saved: ${file.filepath}`);
              compressFiles(uploadLocation, "br");
              compressFiles(uploadLocation, "deflate");
              compressFiles(uploadLocation, "gzip");
            }
          }
        } else {
          DEBUG.log(`No files uploaded for key "${key}"`);
        }
      }
    } else {
      DEBUG.log("Content-type is not multipart/form-data");
    }
    next && next(req, res);
  };
};