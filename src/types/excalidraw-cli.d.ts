declare module "@swiftlysingh/excalidraw-cli" {
  export function convertToPNG(
    inputPath: string,
    outputPath: string,
    options?: { scale?: number }
  ): Promise<void>;
}
