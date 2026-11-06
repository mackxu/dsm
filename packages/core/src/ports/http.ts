export interface HttpTransport {
  request(url: string, options?: RequestInit): Promise<Response>;
}

export interface PlatformPaths {
  userData: string;
  logs: string;
  documents: string;
  downloads: string;
  temporary: string;
}

export interface PlatformAdapter {
  paths(): PlatformPaths;
  revealInFileManager(path: string): Promise<void>;
}
