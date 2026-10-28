//  =====================================================================
//  Measured model sizes
//  =====================================================================
//  A pinned model counts at full size even while it is unloaded, so
//  the broker has to remember how big it was when last loaded. Every
//  read of the backend records each loaded model's size here.
//
//  Only a whole load is a measurement. When memory is tight the
//  backend spills layers to the CPU, and the GPU part it reports then
//  is less than the model needs to load whole: remembering it would
//  undercount a pinned model from then on, exactly when the budget
//  matters most. A size of zero is refused for the same reason the
//  config refuses size_gib 0.
//
//  Kept in the decision-log file (table model_sizes), like the
//  exemplar vectors, so a saxbyd restart does not forget them. A cache
//  only ever makes the broker less careful than it needs to be, never
//  more: lose the table and pinned sizes become unknown until the
//  models load again or the catalog's size_gib fills in, and unknown
//  sizes refuse jobs. Observability stays never load-bearing.

/**
 * @param {{ rows?: { model: string, bytes: number,
 *     measuredAt: string }[], save?: (model: string, bytes: number,
 *     measuredAt: string) => void, now?: () => number }} [options]
 */
export function createSizeCache(options = {}) {
    const now = options.now ?? (() => Date.now());
    const save = options.save ?? (() => {});

    /** @type {Map<string, { bytes: number, measuredAt: string }>} */
    const sizes = new Map();

    for (const row of options.rows ?? []) {
        sizes.set(row.model, { bytes: row.bytes, measuredAt: row.measuredAt });
    }

    /**
     * Records what the backend reports as loaded, skipping partial
     * loads and empty sizes. Only a change is saved, so a steady state
     * writes nothing.
     * @param {import("@saxby/core").LoadedModel[]} loaded
     */
    function record(loaded) {
        for (const model of loaded) {
            if (model.partial) {
                continue;
            }

            if (model.bytes <= 0) {
                continue;
            }

            const known = sizes.get(model.name);

            if (known?.bytes === model.bytes) {
                continue;
            }

            const measuredAt = new Date(now()).toISOString();

            sizes.set(model.name, { bytes: model.bytes, measuredAt });
            save(model.name, model.bytes, measuredAt);
        }
    }

    /**
     * @param {string} model - Canonical name.
     * @returns {{ bytes: number, measuredAt: string } | null}
     */
    function get(model) {
        return sizes.get(model) ?? null;
    }

    return { record, get };
}
