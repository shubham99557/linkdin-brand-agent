// Minimal types for the subset of pdfkit 0.20.2 we use (avoids adding @types/pdfkit as another dependency).
declare module "pdfkit" {
  interface PDFDocumentOptions {
    size?: [number, number];
    margin?: number;
    autoFirstPage?: boolean;
    compress?: boolean;
    info?: { Title?: string; Author?: string; Subject?: string; Creator?: string; Producer?: string; CreationDate?: Date };
  }
  class PDFDocument {
    constructor(options?: PDFDocumentOptions);
    addPage(options?: { size?: [number, number]; margin?: number }): this;
    image(src: Buffer, x: number, y: number, options?: { width?: number; height?: number }): this;
    on(event: "data", listener: (chunk: Buffer) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    end(): void;
  }
  export default PDFDocument;
}
