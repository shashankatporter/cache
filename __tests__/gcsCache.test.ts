import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Writable } from "stream";

import {
    getCacheEntry,
    getCacheVersion,
    saveCache
} from "../src/custom/cloud_provider/gcs";

jest.mock("@google-cloud/storage", () => {
    // gcs.ts reads these when it is loaded, which is when it imports this mock
    process.env.BUCKET_NAME = "test-bucket";
    process.env.UPLOAD_PART_SIZE = "1";
    const bucket = {
        combine: jest.fn(),
        file: jest.fn(),
        getFiles: jest.fn()
    };
    return {
        Storage: jest.fn(() => ({ bucket: () => bucket })),
        mockBucket: bucket
    };
});

const { mockBucket } = jest.requireMock("@google-cloud/storage");

const paths = ["~/.gradle/caches"];
const compressionMethod = CompressionMethod.ZstdWithoutLong;
const options = { compressionMethod, enableCrossOsArchive: false };

interface FakeFile {
    name: string;
    delete: jest.Mock;
    createWriteStream: jest.Mock;
}

let prefix: string;
let objects: Map<string, FakeFile>;
let archivePath: string;
let archiveSize: number;

function fakeFile(name: string): FakeFile {
    let file = objects.get(name);
    if (!file) {
        file = {
            name,
            delete: jest.fn().mockResolvedValue([{}]),
            createWriteStream: jest.fn(
                () =>
                    new Writable({ write: (_chunk, _encoding, done) => done() })
            )
        };
        objects.set(name, file);
    }
    return file;
}

function listed(key: string, updated: string, size: string) {
    return { name: `${prefix}/${key}`, metadata: { updated, size } };
}

function deletedObjects(): string[] {
    return [...objects.values()]
        .filter(file => file.delete.mock.calls.length > 0)
        .map(file => file.name)
        .sort();
}

function partsOf(key: string, count: number): string[] {
    return Array.from(
        { length: count },
        (_, i) => `${prefix}/${key}.part${i + 1}`
    );
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !condition(); i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    expect(condition()).toBe(true);
}

beforeAll(() => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    prefix = `cache/owner/repo/${getCacheVersion(paths, compressionMethod)}`;

    // 2.5 MiB with 1 MiB parts: a three-part parallel upload
    archiveSize = 5 * 512 * 1024;
    archivePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "gcs-cache-test-")),
        "cache.tzst"
    );
    fs.writeFileSync(archivePath, Buffer.alloc(archiveSize, 1));
});

beforeEach(() => {
    objects = new Map();
    mockBucket.file.mockImplementation(fakeFile);
    mockBucket.combine.mockResolvedValue([{}]);
    mockBucket.getFiles.mockResolvedValue([[]]);
});

describe("getCacheEntry", () => {
    test("skips staged upload objects and empty objects", async () => {
        mockBucket.getFiles.mockResolvedValue([
            [
                listed("k-abc.part1", "2026-11-15T10:05:00Z", "67108864"),
                listed(
                    "k-abc.composed0_0",
                    "2026-11-15T10:04:00Z",
                    "2080374784"
                ),
                listed("k-abc", "2026-11-15T10:06:00Z", "0"),
                listed("k-old", "2026-11-14T09:00:00Z", "4294967296")
            ]
        ]);

        const entry = await getCacheEntry(["k-"], paths, options);

        expect(entry.cacheKey).toBe("k-old");
        expect(entry.archiveLocation).toBe(`gs://test-bucket/${prefix}/k-old`);
    });

    test("misses when only staged parts match", async () => {
        mockBucket.getFiles.mockResolvedValue([
            [
                listed("k-abc.part1", "2026-11-15T10:05:00Z", "67108864"),
                listed("k-abc.part2", "2026-11-15T10:05:01Z", "67108864")
            ]
        ]);

        const entry = await getCacheEntry(["k-abc"], paths, options);

        expect(entry.archiveLocation).toBeUndefined();
    });
});

describe("saveCache", () => {
    const save = () =>
        saveCache("k-abc", paths, archivePath, {
            ...options,
            cacheSize: archiveSize
        });

    test("composes the parts and deletes them, plus stale parts of the key", async () => {
        mockBucket.getFiles.mockImplementation(
            async ({ prefix: listPrefix }) => [
                [
                    `${prefix}/k-abc.part9`,
                    `${prefix}/k-abc.composed0_1`,
                    `${prefix}/k-abc.meta`
                ]
                    .filter(name => name.startsWith(listPrefix))
                    .map(fakeFile)
            ]
        );

        await save();

        expect(mockBucket.combine).toHaveBeenCalledWith(
            partsOf("k-abc", 3),
            `${prefix}/k-abc`
        );
        expect(mockBucket.getFiles).toHaveBeenCalledWith({
            prefix: `${prefix}/k-abc.`
        });
        expect(deletedObjects()).toEqual(
            [
                ...partsOf("k-abc", 3),
                `${prefix}/k-abc.part9`,
                `${prefix}/k-abc.composed0_1`
            ].sort()
        );
    });

    test("deletes the staged parts when the upload fails", async () => {
        mockBucket.combine.mockRejectedValue(new Error("compose failed"));

        await expect(save()).rejects.toThrow("compose failed");

        expect(deletedObjects()).toEqual(partsOf("k-abc", 3));
    });

    test("deletes the staged parts on SIGINT, then re-raises it", async () => {
        const kill = jest.spyOn(process, "kill").mockImplementation(() => true);
        let release: () => void = () => undefined;
        const held = new Promise<void>(resolve => (release = resolve));
        fakeFile(`${prefix}/k-abc.part2`).createWriteStream.mockImplementation(
            () =>
                new Writable({
                    write: (_chunk, _encoding, done) => {
                        void held.then(() => done());
                    }
                })
        );
        const listenersBefore = process.listeners("SIGINT");

        const saving = save();
        const onSigint = process
            .listeners("SIGINT")
            .find(listener => !listenersBefore.includes(listener));
        expect(onSigint).toBeDefined();
        (onSigint as (signal: NodeJS.Signals) => void)("SIGINT");

        await waitFor(() => kill.mock.calls.length > 0);
        expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
        expect(deletedObjects()).toEqual(partsOf("k-abc", 3));
        expect(process.listeners("SIGINT")).toEqual(listenersBefore);

        release();
        await saving;
        kill.mockRestore();
    });
});
