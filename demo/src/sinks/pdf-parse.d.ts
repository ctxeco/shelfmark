// SPDX-License-Identifier: Apache-2.0
// Minimal typing for the pdf-parse internal entry. The package's top-level
// index.js runs debug-mode file reads when it can't see a parent module —
// which is exactly the ESM import case — so we import the library file
// directly and declare just the surface we use.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    numpages: number;
    text: string;
  }
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}
