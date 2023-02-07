import { Slice, Dictionary, DictionaryValue } from "ton-core";

// Source: https://github.com/ton-foundation/ton/blob/ae5c0720143e231c32c3d2034cfe4e533a16d969/crypto/block/mc-config.cpp#L1232
const ShardsValue: DictionaryValue<Map<string, number>> = {
    serialize: (src, builder) => {
        throw new Error('Serialization is not implemented');
    },
    parse: (src) => {
        const stack: { slice: Slice, shard: bigint }[] = [{ slice: src.loadRef().beginParse(), shard: 1n << 63n }];
        const res: Map<string, number> = new Map();
        while (stack.length > 0) {
            const { slice, shard } = stack.pop()!;

            const t = slice.loadBit();
            if (!t) {
                slice.skip(4);
                const seqno = slice.loadUint(32);
                const id = BigInt.asIntN(64, shard);
                res.set(id.toString(), seqno);
                continue;
            }

            const delta = (shard & (BigInt.asUintN(64, ~shard) + 1n)) >> 1n;
            stack.push({ slice: slice.loadRef().beginParse(), shard: shard - delta });
            stack.push({ slice: slice.loadRef().beginParse(), shard: shard + delta });
        }
        return res;
    },
};

export function parseShards(cs: Slice) {
    return Dictionary.load(Dictionary.Keys.Uint(32), ShardsValue, cs);
}