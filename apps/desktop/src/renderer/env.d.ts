export {};

declare global {
  interface Window {
    api: {
      ping: () => Promise<string>;
    };
  }
}

