/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";

import { findOldestContiguousSameDepthBand } from "./compartment-runner-compressor";

// Minimal shape for the test — the selector only reads averageDepth and index.
// We use `as unknown as Parameters<typeof findOldestContiguousSameDepthBand>[0][number]`
// to satisfy the ScoredCompartment interface without pulling in the full type.
function scored(...depths: number[]) {
    return depths.map(
        (d, i) =>
            ({
                compartment: { sequence: i } as unknown,
                index: i,
                tokenEstimate: 100,
                averageDepth: d,
                score: 1,
            }) as Parameters<typeof findOldestContiguousSameDepthBand>[0][number],
    );
}

describe("findOldestContiguousSameDepthBand — band-boundary regression", () => {
    it("returns the oldest same-depth run ≥ 2 when it starts at the anchor", () => {
        const band = findOldestContiguousSameDepthBand(scored(0, 0, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        expect(band.map((b) => b.index)).toEqual([0, 1]);
    });

    it("does NOT skip element j when the singleton-run at i ends because of a depth mismatch", () => {
        // This was the bug: with [0, 1, 1, 1], maxPickable=2, the old code did
        // `i = max(j+1, i+1)` when runLen<2 at i=0. That advanced i to 2
        // instead of 1, losing the chance to pick [scored[1], scored[2]] as
        // the first depth-1 band. The fix advances to `j` (which is 1 here)
        // so scored[1] can anchor the next run.
        const band = findOldestContiguousSameDepthBand(scored(0, 1, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        // Must pick the band starting at index 1, not skip to index 2.
        expect(band.map((b) => b.index)).toEqual([1, 2]);
    });

    it("skips past an always-max-depth element without stalling", () => {
        // [d=0, d=max, d=1, d=1] — the middle element is skipped because it's
        // at max depth. After that, scored[2] and scored[3] form a band.
        // Progress guarantee: the outer loop uses `continue` on max-depth and
        // advances i by 1 via `i++`, not via `i = max(j, i+1)`. So this test
        // verifies the skip branch stays separate and functional.
        const band = findOldestContiguousSameDepthBand(scored(0, 5, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        expect(band.map((b) => b.index)).toEqual([2, 3]);
    });

    it("honors the grace period and never considers the newest compartments", () => {
        // [0, 0, 1, 1], graceCompartments=2 → scope shrinks to [0, 0]; depth-0
        // band there is valid.
        const band = findOldestContiguousSameDepthBand(scored(0, 0, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 2,
            floorHeadroom: 10,
        });
        expect(band.map((b) => b.index)).toEqual([0, 1]);

        // Pull grace too tight → no band possible.
        const empty = findOldestContiguousSameDepthBand(scored(0, 0, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 3,
            floorHeadroom: 10,
        });
        expect(empty).toEqual([]);
    });

    it("caps the band at maxPickable regardless of longer runs", () => {
        const band = findOldestContiguousSameDepthBand(scored(0, 0, 0, 0), {
            maxPickable: 3,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        expect(band.map((b) => b.index)).toEqual([0, 1, 2]);
    });

    it("caps the band at floorHeadroom when it is tighter than maxPickable", () => {
        // floorHeadroom < maxPickable — floor wins.
        const band = findOldestContiguousSameDepthBand(scored(0, 0, 0, 0), {
            maxPickable: 4,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 2,
        });
        expect(band.map((b) => b.index)).toEqual([0, 1]);
    });

    it("returns [] when no same-depth run ≥ 2 exists in scope", () => {
        // Every compartment has a distinct rounded depth.
        const band = findOldestContiguousSameDepthBand(scored(0, 1, 2, 3), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        expect(band).toEqual([]);
    });

    it("returns [] when hardMaxPick is below 2", () => {
        expect(
            findOldestContiguousSameDepthBand(scored(0, 0, 0), {
                maxPickable: 1,
                maxMergeDepth: 5,
                graceCompartments: 0,
                floorHeadroom: 10,
            }),
        ).toEqual([]);

        expect(
            findOldestContiguousSameDepthBand(scored(0, 0, 0), {
                maxPickable: 5,
                maxMergeDepth: 5,
                graceCompartments: 0,
                floorHeadroom: 1,
            }),
        ).toEqual([]);
    });
});
