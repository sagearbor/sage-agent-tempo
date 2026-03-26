declare module "playwright" {
  export const chromium: {
    launch(opts?: { headless?: boolean }): Promise<any>;
  };
}
