declare module "webtorrent/dist/webtorrent.min.js" {
  interface TorrentFile {
    readonly name: string;
    readonly length: number;
    blob(options?: { start?: number; end?: number }): Promise<Blob>;
  }

  interface Torrent {
    readonly infoHash: string;
    readonly magnetURI: string;
    readonly length: number;
    readonly progress: number;
    readonly downloadSpeed: number;
    readonly files: TorrentFile[];
    on(event: "download" | "done" | "error", listener: (...args: unknown[]) => void): void;
  }

  interface TorrentOptions {
    announce?: string[];
    announceList?: string[][];
    urlList?: string[];
    name?: string;
    private?: boolean;
  }

  interface WebTorrentClientOptions {
    dht?: boolean;
    lsd?: boolean;
    natPmp?: boolean;
    natUpnp?: boolean;
    tracker?: {
      rtcConfig?: RTCConfiguration;
    };
    utp?: boolean;
  }

  class WebTorrent {
    constructor(options?: WebTorrentClientOptions);
    seed(input: File, options: TorrentOptions, callback: (torrent: Torrent) => void): Torrent;
    add(input: string, options: TorrentOptions, callback: (torrent: Torrent) => void): Torrent;
    on(event: "error", listener: (error: Error) => void): void;
    destroy(callback?: (error?: Error) => void): void;
  }

  export default WebTorrent;
}
