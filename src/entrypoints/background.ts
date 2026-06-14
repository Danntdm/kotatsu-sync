import { browser, defineBackground } from "#imports";
import { onMessage, sendMessage } from "@/messaging";
import type { Nullable } from "@/type";
import { DataConnection, Peer } from "peerjs";
import type { VideoData } from "./kwik.content";

interface MessageObject {
	type: string;
	[key: string]: any;
}
type MessageCallback<T extends MessageObject = MessageObject> = (
	message: T,
) => void;

export default defineBackground(() => {
	class PeerClient {
		public peer: Nullable<Peer> = null;
		public connection: Nullable<DataConnection> = null;
		public status: "HOST" | "JOIN" | "UNKNOWN" = "UNKNOWN";

		private pingInterval: Nullable<NodeJS.Timeout> = null;
		public ping = 0;

		public animepaheTab: Nullable<number> = null;

		constructor() {
			this.createPeerClient();
			this.setupMessagingChannel();
			this.setupExtraListeners();
		}

		get peerId() {
			return this.peer?.id ?? "";
		}

		get connectionStatus() {
			return this.connection?.open ?? false;
		}

		private send(message: MessageObject) {
			if (!this.connection?.open) return;

			console.debug("[PEER OUT]", message);
			this.connection.send(message);
		}

		private setupMessagingChannel() {
			onMessage("peer:id", () => this.peerId);
			onMessage("peer:connection-status", () => this.connectionStatus);
			onMessage("peer:ping", () => this.ping);
			onMessage("peer:current-status", () => this.status);

			onMessage("peer:join", ({ data }) => {
				this.joinHostClient(data);
				return this.connectionStatus;
			});

			onMessage("peer:tab-id", (msg) => {
				if (this.animepaheTab) return;
				this.animepaheTab = msg.sender.tab?.id ?? null;
			});

			onMessage("animepahe:url-change", (msg) => {
				if (this.status !== "HOST") return;

				this.send({
					type: "url-sync",
					url: msg.data,
				});
			});

			onMessage("video:data-out", (msg) => {
				this.send(msg.data);
			});

			onMessage("peer:disconnect", () => {
				this.cleanupConnection();
				this.cleanupPeer();
				if (this.pingInterval) {
					clearInterval(this.pingInterval);
					this.pingInterval = null;
				}
			});

			onMessage("peer:refresh-id", async () => {
				await this.createPeerClient();
				return this.peerId;
			});
		}

		private setupExtraListeners() {
			// Extra listeners for animepahe synchronization
			browser.tabs.onRemoved.addListener((tabId) => {
				if (tabId === this.animepaheTab) {
					this.animepaheTab = null;
				}
			});

			browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
				if (
					tabId === this.animepaheTab &&
					tab.url &&
					!tab.url.includes("animepahe")
				) {
					this.animepaheTab = null;
				}
			});
		}

		private cleanupConnection() {
			if (this.pingInterval) {
				clearInterval(this.pingInterval);
				this.pingInterval = null;
			}

			this.connection?.close();
			this.connection = null;
		}

		private cleanupPeer() {
			this.cleanupConnection();
			this.peer?.destroy();
			this.peer = null;
		}

		private async createPeerClient() {
			this.cleanupPeer();

			const peer = new Peer();

			this.peer = peer;
			this.setupPeerEvents(peer);

			await new Promise<void>((resolve, reject) => {
				peer.once("open", () => resolve());
				peer.once("error", reject);
			});
		}

		private setupPeerEvents(peer: Peer) {
			peer.on("close", () => {
				console.log("[PEER CLOSED]");
			});

			peer.on("connection", (connection) => {
				console.log("Incoming connection");

				this.status = "HOST";
				sendMessage("peer:status-change", this.status);

				this.attachConnection(connection);
			});
		}

		public joinHostClient(hostId: string) {
			const connection = this.peer?.connect(hostId);

			if (!connection) {
				throw new Error("Failed to create connection");
			}

			this.status = "JOIN";
			sendMessage("peer:status-change", this.status);
			this.attachConnection(connection);
		}

		private startPingFeed() {
			if (this.pingInterval) {
				clearInterval(this.pingInterval);
				this.pingInterval = null;
			}

			this.pingInterval = setInterval(() => {
				this.send({
					type: "ping",
					timestamp: performance.now(),
				});
			}, 1000);
		}

		private attachConnection(connection: DataConnection) {
			this.cleanupConnection();

			this.connection = connection;

			connection.on("open", () => {
				console.log("[CONNECTION OPENED]");

				this.startPingFeed();
				sendMessage("peer:connection-change", this.connectionStatus);
			});

			connection.on("close", () => {
				console.log("[CONNECTION CLOSED]");
				this.cleanupConnection();
				sendMessage("peer:connection-change", this.connectionStatus);
			});

			connection.on("error", console.error);

			connection.on("data", (data) => {
				const message = data as MessageObject;

				console.debug("[PEER IN]", message);

				this.handler[message.type]?.(message);
			});
		}

		private handler: Record<string, MessageCallback> = {
			ping: (message) => {
				this.send({
					type: "pong",
					timestamp: message.timestamp,
				});
			},

			pong: (message) => {
				this.ping = performance.now() - message.timestamp;
			},
			"url-sync": async (message) => {
				if (!this.animepaheTab) return;

				await sendMessage(
					"animepahe:url-sync",
					message.url,
					this.animepaheTab,
				);
			},
			"data-in": async (message) => {
				if (!this.animepaheTab) return;
				sendMessage(
					"video:data-in",
					message as VideoData,
					this.animepaheTab,
				);
			},
		};
	}

	new PeerClient();
});
