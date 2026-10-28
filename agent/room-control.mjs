import { randomUUID } from "node:crypto";
// Room credentials remain in the agent process and expire when its browser
// stops renewing the connection. The desktop renderer receives public state.
export function createRoomControl({ fetcher = fetch, now = Date.now, ttlMs = 180000 } = {}) {
    const rooms = new Map();
    async function read(room, action) {
        const url = new URL("/api/sessions", room.origin);
        if (!action) {
            url.searchParams.set("token", room.token);
            url.searchParams.set("deviceId", room.deviceId);
        }
        const response = await fetcher(url, {
            method: action ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10000),
            headers: { "content-type": "application/json" },
            ...(action ? { body: JSON.stringify({ ...action, token: room.token, deviceId: room.deviceId, name: room.name }) } : {}),
        });
        const result = await response.json();
        if (!response.ok || !result.session)
            throw new Error(result.error || "The room is unavailable. Reconnect it in the browser.");
        room.session = result.session;
        return result.session;
    }
    const current = id => {
        const room = rooms.get(id);
        if (!room || now() - room.renewedAt > ttlMs)
            throw new Error("Room connection expired. Open this room in your browser again.");
        return room;
    };
    return {
        async register(origin, { token, deviceId, name }) {
            if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(token) || typeof deviceId !== "string" || !deviceId || deviceId.length > 80)
                throw new Error("Invalid room connection.");
            let room = [...rooms.values()].find(room => room.origin === origin && room.token === token && room.deviceId === deviceId);
            room ||= { id: randomUUID(), origin, token, deviceId, name: String(name || "Companion").slice(0, 100) };
            await read(room);
            if (!room.session.participants.some(participant => participant.deviceId === deviceId))
                throw new Error("Join the room before connecting Companion controls.");
            room.renewedAt = now();
            rooms.set(room.id, room);
            return { id: room.id };
        },
        list() {
            for (const [id, room] of rooms)
                if (now() - room.renewedAt > ttlMs)
                    rooms.delete(id);
            return [...rooms.values()].map(room => ({ id: room.id, label: `Room ${room.token.slice(0, 4)} · ${new URL(room.origin).hostname}`, host: room.session.hostId === room.deviceId,
                sources: room.session.sources, selectedMedia: room.session.selectedMedia, watchRecords: room.session.watchRecords, updatedAt: room.renewedAt }));
        },
        async act(id, action) {
            const room = current(id);
            const session = await read(room);
            if (session.hostId !== room.deviceId)
                throw new Error("Only the room host can change its shared queue.");
            return read(room, { ...action, expectedSeq: session.seq });
        },
    };
}
