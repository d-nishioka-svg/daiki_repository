/**
 * Helper to compress and resize base64 images on the client side
 * to reduce network footprint and accelerate Gemini's inference processing.
 */
export function resizeAndCompressImage(
  base64Data: string,
  maxSize: number = 800,
  quality: number = 0.8
): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    // Avoid processing if it is not an image base64
    if (!base64Data.startsWith("data:image/")) {
      resolve({ base64: base64Data, mimeType: "image/jpeg" });
      return;
    }

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = base64Data;
    img.onload = () => {
      try {
        let width = img.width;
        let height = img.height;

        // Maintain aspect ratio while sizing down if dimensions exceed limit
        if (width > height) {
          if (width > maxSize) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve({ base64: base64Data, mimeType: "image/jpeg" });
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const compressedBase64 = canvas.toDataURL("image/jpeg", quality);
        resolve({ base64: compressedBase64, mimeType: "image/jpeg" });
      } catch (err) {
        console.error("Canvas compression failed", err);
        resolve({ base64: base64Data, mimeType: "image/jpeg" });
      }
    };
    img.onerror = (err) => {
      console.warn("Image load failed, returning original content", err);
      resolve({ base64: base64Data, mimeType: "image/jpeg" });
    };
  });
}
