import * as cacheUtils from "@actions/cache/lib/internal/cacheUtils";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as tar from "@actions/cache/lib/internal/tar";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import * as path from "path";

import { restoreCache } from "../src/custom/cache";
import * as gcs from "../src/custom/cloud_provider/gcs";

jest.mock("@actions/cache/lib/internal/cacheUtils", () => ({
    ...jest.requireActual("@actions/cache/lib/internal/cacheUtils"),
    createTempDirectory: jest.fn(),
    getArchiveFileSizeInBytes: jest.fn(),
    getCompressionMethod: jest.fn(),
    unlinkFile: jest.fn()
}));
jest.mock("@actions/cache/lib/internal/tar");
jest.mock("@actions/exec");
jest.mock("@actions/io");
jest.mock("../src/custom/cloud_provider/gcs", () => ({
    downloadCache: jest.fn(),
    getCacheEntry: jest.fn()
}));
jest.mock("../src/custom/cloud_provider/s3", () => ({}));

const paths = ["~/.gradle/caches"];
const archivePath = path.join("/tmp/restore", "cache.tzst");
const goodArchive = { exitCode: 0, stdout: "", stderr: "" };
const truncatedArchive = {
    exitCode: 1,
    stdout: "",
    stderr: "cache.tzst : Read error (39) : premature end"
};

let entries: Record<string, { cacheKey: string; archiveLocation: string }>;

beforeEach(() => {
    entries = {
        "k-abc": { cacheKey: "k-abc", archiveLocation: "gs://b/p/k-abc" },
        // the branch prefix also matches the corrupt primary-key archive
        "k-": { cacheKey: "k-abc", archiveLocation: "gs://b/p/k-abc" },
        "main-": { cacheKey: "main-xyz", archiveLocation: "gs://b/p/main-xyz" }
    };
    (gcs.getCacheEntry as jest.Mock).mockImplementation(
        async ([key]: string[]) => entries[key] ?? {}
    );
    (cacheUtils.getCompressionMethod as jest.Mock).mockResolvedValue(
        CompressionMethod.ZstdWithoutLong
    );
    (cacheUtils.createTempDirectory as jest.Mock).mockResolvedValue(
        "/tmp/restore"
    );
    (cacheUtils.getArchiveFileSizeInBytes as jest.Mock).mockReturnValue(1024);
    (cacheUtils.unlinkFile as jest.Mock).mockResolvedValue(undefined);
    (io.which as jest.Mock).mockResolvedValue("/usr/bin/zstd");
});

test("a corrupt archive falls back to the next restore key", async () => {
    (exec.getExecOutput as jest.Mock)
        .mockResolvedValueOnce(truncatedArchive)
        .mockResolvedValueOnce(goodArchive);

    const key = await restoreCache(paths, "k-abc", ["k-", "main-"]);

    expect(key).toBe("main-xyz");
    expect(
        (gcs.downloadCache as jest.Mock).mock.calls.map(call => call[0])
    ).toEqual(["gs://b/p/k-abc", "gs://b/p/main-xyz"]);
    expect(exec.getExecOutput).toHaveBeenCalledWith(
        "zstd",
        ["-t", archivePath],
        expect.objectContaining({ ignoreReturnCode: true })
    );
    expect(tar.extractTar).toHaveBeenCalledTimes(1);
});

test("misses without extracting when every archive is corrupt", async () => {
    (exec.getExecOutput as jest.Mock).mockResolvedValue(truncatedArchive);

    const key = await restoreCache(paths, "k-abc", ["k-", "main-"]);

    expect(key).toBeUndefined();
    expect(gcs.downloadCache).toHaveBeenCalledTimes(2);
    expect(tar.extractTar).not.toHaveBeenCalled();
});

test("extracts without the check when the decompressor is missing", async () => {
    (io.which as jest.Mock).mockResolvedValue("");

    const key = await restoreCache(paths, "k-abc", ["k-", "main-"]);

    expect(key).toBe("k-abc");
    expect(exec.getExecOutput).not.toHaveBeenCalled();
    expect(tar.extractTar).toHaveBeenCalledTimes(1);
});

test("lookup-only returns the first match without downloading", async () => {
    const key = await restoreCache(paths, "k-abc", ["k-", "main-"], {
        lookupOnly: true
    });

    expect(key).toBe("k-abc");
    expect(gcs.downloadCache).not.toHaveBeenCalled();
});
