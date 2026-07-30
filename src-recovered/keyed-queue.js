export class KeyedQueue {
    #tails = new Map();
    async run(key, task) {
        const previous = this.#tails.get(key) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.#tails.set(key, tail);
        await previous.catch(() => undefined);
        try {
            return await task();
        }
        finally {
            release();
            if (this.#tails.get(key) === tail)
                this.#tails.delete(key);
        }
    }
}
//# sourceMappingURL=keyed-queue.js.map