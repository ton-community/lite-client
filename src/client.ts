import { Address, Cell, loadShardStateUnsplit, CurrencyCollection, loadAccount, Account } from "ton-core";
import { LiteEngine } from "./engines/engine";
import { parseShards } from "./parser/parseShards";
import { Functions, liteServer_blockData, liteServer_blockHeader, liteServer_transactionId, liteServer_transactionId3, tonNode_blockIdExt } from "./schema";
import DataLoader from "dataloader";
import { crc16 } from "./utils/crc16";

//
// Ops
//

const lookupBlockByID = async (engine: LiteEngine, block: BlockLookupIDRequest) => {
    return await engine.query(Functions.liteServer_lookupBlock, {
        kind: 'liteServer.lookupBlock',
        mode: (block.getBlockHeaderMode << 4) | 1,
        id: {
            kind: 'tonNode.blockId',
            seqno: block.seqno,
            shard: block.shard,
            workchain: block.workchain
        },
        lt: null,
        utime: null
    }, { timeout: 5000 });
}

const lookupBlockByLt = async (engine: LiteEngine, block: BlockLookupLtRequest) => {
    return await engine.query(Functions.liteServer_lookupBlock, {
        kind: 'liteServer.lookupBlock',
        mode: (block.getBlockHeaderMode << 4) | 2,
        id: {
            kind: 'tonNode.blockId',
            seqno: 0,
            shard: block.shard,
            workchain: block.workchain
        },
        lt: block.lt,
        utime: null
    }, { timeout: 5000 });
}

const lookupBlockByUtime = async (engine: LiteEngine, block: BlockLookupUtimeRequest) => {
    return await engine.query(Functions.liteServer_lookupBlock, {
        kind: 'liteServer.lookupBlock',
        mode: (block.getBlockHeaderMode << 4) | 4,
        id: {
            kind: 'tonNode.blockId',
            seqno: 0,
            shard: block.shard,
            workchain: block.workchain
        },
        lt: null,
        utime: block.utime
    }, { timeout: 5000 });
}

export type BlockID = {
    seqno: number;
    shard: string;
    workchain: number;
    rootHash: Buffer;
    fileHash: Buffer;
}
const blockIDToCacheKey = (id: {
    workchain: number;
    shard: string;
    seqno: number;
}) => id.workchain + '::' + id.shard + '::' + id.seqno;
const blockIDToBlockIDExt = (id: BlockID): tonNode_blockIdExt => ({
    kind: 'tonNode.blockIdExt',
    seqno: id.seqno,
    shard: id.shard,
    workchain: id.workchain,
    rootHash: id.rootHash,
    fileHash: id.fileHash,
});

type AllShardsResponse = {
    id: tonNode_blockIdExt;
    shards: {
        [key: string]: {
            [key: string]: number;
        };
    };
    raw: Buffer;
    proof: Buffer;
}
const getAllShardsInfo = async (engine: LiteEngine, block: BlockID) => {
    let res = (await engine.query(Functions.liteServer_getAllShardsInfo, { kind: 'liteServer.getAllShardsInfo', id: block }, { timeout: 5000 }));
    let parsed = parseShards(Cell.fromBoc(res.data)[0].beginParse());
    let shards: { [key: string]: { [key: string]: number } } = {};
    for (let p of parsed) {
        shards[p[0]] = {};
        for (let p2 of p[1]) {
            shards[p[0]][p2[0]] = p2[1];
        }
    }
    return {
        id: res.id,
        shards,
        raw: res.data,
        proof: res.proof
    }
}

const getBlockHeader = async (engine: LiteEngine, block: BlockID, mode: number) => {
    return await engine.query(Functions.liteServer_getBlockHeader, {
        kind: 'liteServer.getBlockHeader',
        mode,
        id: blockIDToBlockIDExt(block),
    }, { timeout: 5000 });
}

const getBlock = async(engine: LiteEngine, props: BlockID) => {
    return await engine.query(Functions.liteServer_getBlock, {
        kind: 'liteServer.getBlock',
        id: blockIDToBlockIDExt(props),
    }, { timeout: 5000 });
}

type BlockLookupRequestCommon = {
    shard: string;
    workchain: number;
    getBlockHeaderMode: number;
}
type BlockLookupIDRequest = BlockLookupRequestCommon & { mode: 'id', seqno: number }
type BlockLookupLtRequest = BlockLookupRequestCommon & { mode: 'lt', lt: string }
type BlockLookupUtimeRequest = BlockLookupRequestCommon & { mode: 'utime', utime: number }

export const GetBlockHeaderModes = {
    None: 0,
    WithStateUpdate: 1 << 0,
    WithValueFlow: 1 << 1,
    WithExtra: 1 << 4,
    WithShardHashes: 1 << 5,
    WithPrevBlkSignatures: 1 << 6,
};

export const FetchTransactionIDModes = {
    None: 0,
    FetchAccount: 1,
    FetchLt: 2,
    FetchHash: 4,
    FetchAll: -1,
};
FetchTransactionIDModes.FetchAll = FetchTransactionIDModes.FetchAccount | FetchTransactionIDModes.FetchLt | FetchTransactionIDModes.FetchHash;

export const ListBlockTransactionsModes = {
    None: 0,
    WithProof: 32,
    Reverse: 64,
    WithAfter: 128,
};

export const GetConfigModes = {
    None: 0,
    WithValidatorSet: 16,
    WithSpecialSmc: 32,
    WithWorkchainInfo: 256,
    WithCapabilities: 512,
    FromPreviousKeyBlock: 0x8000,
};

export const GetBlockProofModes = {
    None: 0,
    WithTo: 1,
    ToLastStateBlock: 2,
    WithGivenBase: 0x1000,
};

export const GetValidatorStatsModes = {
    None: 0,
    WithStartAfter: 1,
    AllowEqual: 2,
    WithModifiedAfter: 4,
};

export const RunGetMethodModes = {
    None: 0,
    WithBlockProofs: 1,
    WithAccountProof: 2,
    WithStack: 4,
    WithC7: 8,
    WithLibraryExtras: 16,
};

/**
 * The main lite client class
 */
export class LiteClient {
    readonly engine: LiteEngine;
    #blockLookup: DataLoader<BlockLookupIDRequest | BlockLookupUtimeRequest | BlockLookupLtRequest, liteServer_blockHeader, string>;
    #shardsLookup: DataLoader<BlockID, AllShardsResponse, string>;
    #blockHeader: DataLoader<{ id: BlockID, mode: number }, liteServer_blockHeader, string>;
    #block: DataLoader<BlockID, liteServer_blockData, string>;

    constructor(opts: { engine: LiteEngine, batchSize?: number | undefined | null }) {
        this.engine = opts.engine;
        let batchSize = typeof opts.batchSize === 'number' ? opts.batchSize : 100;

        this.#blockLookup = new DataLoader(async (s) => {
            return await Promise.all(s.map((v) => {
                switch (v.mode) {
                    case 'id':
                        return lookupBlockByID(this.engine, v);
                    case 'lt':
                        return lookupBlockByLt(this.engine, v);
                    case 'utime':
                        return lookupBlockByUtime(this.engine, v);
                    default:
                        throw new Error('Unsupported mode');
                }
            }));
        }, { maxBatchSize: batchSize, cacheKeyFn: (s) => {
            switch (s.mode) {
                case 'id':
                    return blockIDToCacheKey(s) + '::' + s.getBlockHeaderMode;
                case 'lt':
                    return s.workchain + '::' + s.shard + '::lt-' + s.lt  + '::' + s.getBlockHeaderMode;
                case 'utime':
                    return s.workchain + '::' + s.shard + '::utime-' + s.utime  + '::' + s.getBlockHeaderMode;
                default:
                    throw new Error('Unsupported mode');
            }
        }});

        this.#blockHeader = new DataLoader(async (s) => {
            return await Promise.all(s.map((v) => getBlockHeader(this.engine, v.id, v.mode)));
        }, { maxBatchSize: batchSize, cacheKeyFn: (s) => blockIDToCacheKey(s.id) + '::' + s.mode });

        this.#shardsLookup = new DataLoader<BlockID, AllShardsResponse, string>(async (s) => {
            return await Promise.all(s.map((v) => getAllShardsInfo(this.engine, v)));
        }, { maxBatchSize: batchSize, cacheKeyFn: (s) => blockIDToCacheKey(s) });

        this.#block = new DataLoader(async (s) => {
            return await Promise.all(s.map((v) => getBlock(this.engine, v)));
        }, { maxBatchSize: batchSize, cacheKeyFn: (s) => blockIDToCacheKey(s) });
    }

    //
    // Sending
    //

    /**
     * Sends an external message.
     * 
     * @param message The external message serialized as BOC
     * 
     * @remarks
     * 
     * In the current official implementation of lite server, the returned status is always 1 if some initial checks on the message pass.
     * 
     * @returns An object containing status
     */
    sendMessage = async (message: Buffer) => {
        let res = await this.engine.query(Functions.liteServer_sendMessage, { kind: 'liteServer.sendMessage', body: message }, { timeout: 5000 });
        return {
            status: res.status
        };
    }

    //
    // State
    //

    /**
     * Gets masterchain info.
     * 
     * @returns An object containing last masterchain block id, state root hash, and zero/genesis/init state
     */
    getMasterchainInfo = async () => {
        return this.engine.query(Functions.liteServer_getMasterchainInfo, { kind: 'liteServer.masterchainInfo' }, { timeout: 5000 });
    }

    /**
     * Combination of `getVersion` and `getMasterchainInfo`. Also includes the unix timestamp of the last masterchain block.
     * 
     * @returns An object containing version information, masterchain info, last masterchain block timestamp
     */
    getMasterchainInfoExt = async () => {
        return this.engine.query(Functions.liteServer_getMasterchainInfoExt, { kind: 'liteServer.masterchainInfoExt', mode: 0 }, { timeout: 5000 });
    }

    /**
     * Gets the unix timestamp of the lite server.
     * 
     * @remarks
     * 
     * Uses the `getTime` lite server call.
     * 
     * @returns The unix timestamp of the lite server
     */
    getCurrentTime = async () => {
        return (await this.engine.query(Functions.liteServer_getTime, { kind: 'liteServer.getTime' }, { timeout: 5000 })).now;
    }

    /**
     * Gets the version of the lite server.
     * 
     * @returns An object containing information about the version of the lite server
     */
    getVersion = async () => {
        return (await this.engine.query(Functions.liteServer_getVersion, { kind: 'liteServer.getVersion' }, { timeout: 5000 }));
    }

    /**
     * Gets all config params at the given block.
     * 
     * @param block Block ID of the target block
     * 
     * @param mode Optional flags that indicate what must be included in the result
     * 
     * @remarks
     * 
     * Uses the `getConfigAll` lite server call.
     * 
     * For available modes, take a look at `GetConfigModes`.
     * 
     * @returns Config dictionary
     */
    getConfig = async (block: BlockID, mode: number = GetConfigModes.None) => {
        let res = await this.engine.query(Functions.liteServer_getConfigAll, {
            kind: 'liteServer.getConfigAll',
            id: blockIDToBlockIDExt(block),
            mode,
        }, { timeout: 5000 });

        const configProof = Cell.fromBoc(res.configProof)[0];
        const configCell = configProof.refs[0];
        const cs = configCell.beginParse();
        const shardState = loadShardStateUnsplit(cs);
        if (!shardState.extras) {
            throw Error('Invalid response');
        }
        return shardState.extras;
    }

    /**
     * Gets the specified config params at the given block.
     * 
     * @param block Block ID of the target block
     * 
     * @param paramList Parameters to fetch
     * 
     * @param mode Optional flags that indicate what must be included in the result
     * 
     * @remarks
     * 
     * For available modes, take a look at `GetConfigModes`.
     * 
     * @returns An object containing block ID, used mode, state (block) proof and config proof
     */
    getConfigParams = async (block: BlockID, paramList: number[], mode: number = GetConfigModes.None) => {
        return await this.engine.query(Functions.liteServer_getConfigParams, {
            kind: 'liteServer.getConfigParams',
            mode,
            id: blockIDToBlockIDExt(block),
            paramList,
        }, { timeout: 5000 });
    }

    //
    // Account
    //

    /**
     * Gets the account state at the given block.
     * 
     * @param address Address of the target account
     * 
     * @param block Block ID of the target block
     * 
     * @param timeout Optional API timeout (default = 5s)
     * 
     * @returns An object containing masterchain block ID and proof, shard block ID and proof, parsed and raw Account state, last transaction and balance properties
     */
    getAccountState = async (address: Address, block: BlockID, timeout: number = 5000) => {
        let res = (await this.engine.query(Functions.liteServer_getAccountState, {
            kind: 'liteServer.getAccountState',
            id: blockIDToBlockIDExt(block),
            account: {
                kind: 'liteServer.accountId',
                workchain: address.workChain,
                id: address.hash
            }
        }, { timeout }));

        let account: Account | null = null
        let balance: CurrencyCollection = { coins: 0n };
        let lastTx: { lt: string, hash: Buffer } | null = null;
        if (res.state.length > 0) {
            const cs = Cell.fromBoc(res.state)[0].beginParse()
            if (cs.loadBit()) {
                account = loadAccount(cs);
                balance = account.storage.balance;
                let shardState = loadShardStateUnsplit(Cell.fromBoc(res.proof)[1].refs[0].beginParse());
                let hashId = BigInt('0x' + address.hash.toString('hex'));
                let pstate = shardState.accounts?.get(hashId);
                if (pstate) {
                    let hashStr = pstate.shardAccount.lastTransactionHash.toString(16)
                    if (hashStr.length % 2 !== 0) {
                        hashStr = '0' + hashStr
                    }
                    lastTx = { hash: Buffer.from(hashStr, 'hex'), lt: pstate.shardAccount.lastTransactionLt.toString(10) };
                }
            }
        }

        return {
            state: account,
            lastTx,
            balance,
            raw: res.state,
            proof: res.proof,
            block: res.id,
            shardBlock: res.shardblk,
            shardProof: res.shardProof
        }
    }

    /**
     * Gets the prunned account state (mostly its hash) at the given block.
     * 
     * @param address Address of the target account
     * 
     * @param block Block ID of the target block
     * 
     * @param timeout Optional API timeout (default = 5s)
     * 
     * @returns An object containing masterchain block ID and proof, shard block ID and proof, raw prunned Account state and its hash
     */
    getAccountStatePrunned = async (address: Address, block: BlockID, timeout: number = 5000) => {
        let res = (await this.engine.query(Functions.liteServer_getAccountStatePrunned, {
            kind: 'liteServer.getAccountStatePrunned',
            id: blockIDToBlockIDExt(block),
            account: {
                kind: 'liteServer.accountId',
                workchain: address.workChain,
                id: address.hash
            }
        }, { timeout }));

        let stateHash: Buffer | null = null;
        if (res.state.length > 0) {
            let stateCell = Cell.fromBoc(res.state)[0];
            if (!stateCell.isExotic) {
                throw new Error('Prunned state is not exotic');
            }
            stateHash = stateCell.bits.subbuffer(8, 256);
        }

        return {
            stateHash,
            raw: res.state,
            proof: res.proof,
            block: res.id,
            shardBlock: res.shardblk,
            shardProof: res.shardProof
        }
    }

    /**
     * Gets the transaction of the given account at the given lt in the given block.
     * 
     * @param address Address of the target account
     * 
     * @param lt Logical time of the target transaction
     * 
     * @param block Block ID of the target block
     * 
     * @remarks
     * 
     * Uses the `getOneTransaction` lite server call.
     * 
     * @returns An object containing the block ID, its proof, and raw transaction data
     */
    getAccountTransaction = async (address: Address, lt: string, block: BlockID) => {
        return await this.engine.query(Functions.liteServer_getOneTransaction, {
            kind: 'liteServer.getOneTransaction',
            id: block,
            account: {
                kind: 'liteServer.accountId',
                workchain: address.workChain,
                id: address.hash
            },
            lt: lt
        }, { timeout: 5000 });
    }

    /**
     * Gets at most `count` (but see remarks) transactions of the given account starting with the given lt and hash as the most recent (it will be the first in the returned list) and going into the past from that transaction.
     * 
     * @param address Address of the target account
     * 
     * @param lt Logical time of the target transaction
     * 
     * @param hash Hash of the target transaction
     * 
     * @param count The number of transactions to fetch
     * 
     * @remarks
     * 
     * Uses the `getTransactions` lite server call.
     * 
     * In the current official implementation of lite server, `count` will be set to 16 if it is greater than 16.
     * 
     * @returns 
     */
    getAccountTransactions = async (address: Address, lt: string, hash: Buffer, count: number) => {
        let loaded = await this.engine.query(Functions.liteServer_getTransactions, {
            kind: 'liteServer.getTransactions',
            count,
            account: {
                kind: 'liteServer.accountId',
                workchain: address.workChain,
                id: address.hash
            },
            lt: lt,
            hash: hash
        }, { timeout: 5000 });
        return {
            ids: loaded.ids,
            transactions: loaded.transactions
        };
    }

    /**
     * Runs the specified get method on the specified account at the given block with the specified params.
     * 
     * @param address Address of the target account
     * 
     * @param method String or number selector of the target method
     * 
     * @param params Params (stack) to pass to the method
     * 
     * @param block Block ID of the target block
     * 
     * @remarks
     * 
     * Uses the `runSmcMethod` lite server call.
     * 
     * In the current official implementation of lite server, `params` length cannot be greater than or equal to 64 kilobytes.
     * 
     * @returns An object containing exit code, raw result (stack) data, block ID and shard block ID
     */
    runMethod = async (address: Address, method: string | number, params: Buffer, block: BlockID) => {
        let res = await this.engine.query(Functions.liteServer_runSmcMethod, {
            kind: 'liteServer.runSmcMethod',
            mode: RunGetMethodModes.WithStack,
            id: blockIDToBlockIDExt(block),
            account: {
                kind: 'liteServer.accountId',
                workchain: address.workChain,
                id: address.hash
            },
            methodId: (typeof method === 'number' ? method : ((crc16(method) & 0xffff) | 0x10000)) + '',
            params,
        }, { timeout: 5000 });
        return {
            exitCode: res.exitCode,
            result: res.result ? res.result.toString('base64') : null,
            block: {
                seqno: res.id.seqno,
                shard: res.id.shard,
                workchain: res.id.workchain,
                rootHash: res.id.rootHash,
                fileHash: res.id.fileHash
            },
            shardBlock: {
                seqno: res.shardblk.seqno,
                shard: res.shardblk.shard,
                workchain: res.shardblk.workchain,
                rootHash: res.shardblk.rootHash,
                fileHash: res.shardblk.fileHash
            },
        }
    }

    //
    // Block
    //

    /**
     * Looks up a block by seqno, shard and workchain and returns data as if `getBlockHeader` was called on it.
     * 
     * @param block Lookup parameters of the target block
     * 
     * @param getBlockHeaderMode The mode to be used for generating header proof
     * 
     * @remarks
     * 
     * For available modes, take a look at `GetBlockHeaderModes`.
     * 
     * Uses the `lookupBlock` lite server call.
     * 
     * @returns The same object as if `getBlockHeader` was called on the found block
     */
    lookupBlockByID = async (block: { seqno: number, shard: string, workchain: number }, getBlockHeaderMode: number = GetBlockHeaderModes.None) => {
        return await this.#blockLookup.load({ ...block, mode: 'id', getBlockHeaderMode });
    }

    /**
     * Looks up a block by lt, shard and workchain and returns data as if `getBlockHeader` was called on it.
     * 
     * @param block Lookup parameters of the target block
     * 
     * @param getBlockHeaderMode The mode to be used for generating header proof
     * 
     * @remarks
     * 
     * For available modes, take a look at `GetBlockHeaderModes`.
     * 
     * Uses the `lookupBlock` lite server call.
     * 
     * @returns The same object as if `getBlockHeader` was called on the found block
     */
    lookupBlockByLt = async (block: { shard: string, workchain: number, lt: string }, getBlockHeaderMode: number = GetBlockHeaderModes.None) => {
        return await this.#blockLookup.load({ ...block, mode: 'lt', getBlockHeaderMode });
    }

    /**
     * Looks up a block by unix time, shard and workchain and returns data as if `getBlockHeader` was called on it.
     * 
     * @param block Lookup parameters of the target block
     * 
     * @param getBlockHeaderMode The mode to be used for generating header proof
     * 
     * @remarks
     * 
     * For available modes, take a look at `GetBlockHeaderModes`.
     * 
     * Uses the `lookupBlock` lite server call.
     * 
     * @returns The same object as if `getBlockHeader` was called on the found block
     */
    lookupBlockByUtime = async (block: { shard: string, workchain: number, utime: number }, getBlockHeaderMode: number = GetBlockHeaderModes.None) => {
        return await this.#blockLookup.load({ ...block, mode: 'utime', getBlockHeaderMode });
    }

    /**
     * Gets the raw data associated with the specified block ID.
     * 
     * @param block Block ID of the target block
     * 
     * @returns An object containing the block ID and the raw data of that block
     */
    getBlock = async (block: BlockID) => {
        return this.#block.load(block);
    }

    /**
     * Gets the header proof associated with the specified block ID constructed according to the specified mode.
     * 
     * @param block Block ID of the target block
     * 
     * @param mode The mode to be used for generating header proof
     * 
     * @remarks
     * 
     * For available modes, take a look at `GetBlockHeaderModes`.
     * 
     * @returns An object containing the block ID, used mode, and the header proof
     */
    getBlockHeader = async (block: BlockID, mode: number = GetBlockHeaderModes.WithStateUpdate) => {
        return this.#blockHeader.load({
            id: block,
            mode,
        });
    }

    /**
     * Gets the proof chain from the given block to some other block.
     * 
     * @param from Block ID of the first target block
     * 
     * @param args Either the second target block and a flag indicating whether to use one of the given blocks as the base block, or a flag indicating whether to use the last state block or the last processed block
     * 
     * @returns An object containing whether the proof is complete, the used from and to blocks, and the links between them
     */
    getBlockProof = async (from: BlockID, args: {
        to: BlockID,
        givenBase: boolean,
    } | {
        toLastStateBlock: boolean,
    }) => {
        let mode: number;
        let to: BlockID | null = null;
        if ('to' in args) {
            to = args.to;
            mode = GetBlockProofModes.WithTo;
            if (args.givenBase) mode |= GetBlockProofModes.WithGivenBase;
        } else {
            mode = args.toLastStateBlock ? GetBlockProofModes.ToLastStateBlock : GetBlockProofModes.None;
        }
        return await this.engine.query(Functions.liteServer_getBlockProof, {
            kind: 'liteServer.getBlockProof',
            mode,
            knownBlock: blockIDToBlockIDExt(from),
            targetBlock: to ? blockIDToBlockIDExt(to) : null,
        }, { timeout: 5000 });
    }

    /**
     * Gets the total state of the blockchain at that block.
     * 
     * @param block Block ID of the target block
     * 
     * @remarks
     * 
     * In the current official implementation of lite server, this method will return an error for blocks where seqno > 1000 (due to the state possibly being too large).
     * 
     * For seqno = 0, returns the zero/genesis/init state.
     * 
     * @returns An object containing the block ID, root hash, file hash, and data (the total state)
     */
    getState = async (block: BlockID) => {
        return await this.engine.query(Functions.liteServer_getState, {
            kind: 'liteServer.getState',
            id: blockIDToBlockIDExt(block),
        }, { timeout: 5000 });
    }

    /**
     * Gets the shard info at the given block.
     * 
     * @param block Block ID of the target block
     * 
     * @param shard Parameters of shard to get info for
     * 
     * @returns An object containing masterchain block ID, shard block ID, raw proof data and raw shard description data
     */
    getShardInfo = async (block: BlockID, shard: { workchain: number, shard: string, exact: boolean }) => {
        return await this.engine.query(Functions.liteServer_getShardInfo, {
            kind: 'liteServer.getShardInfo',
            id: blockIDToBlockIDExt(block),
            workchain: shard.workchain,
            shard: shard.shard,
            exact: shard.exact,
        }, { timeout: 5000 });
    }

    /**
     * Get the shard info for all shards at the given block.
     * 
     * @param block Block ID of the target block
     * 
     * @returns An object containing masterchain block ID, raw proof data for the masterchain block and shard hashes dictionary, and the raw data for the shard hashes dictionary itself
     */
    getAllShardsInfo = async (block: BlockID) => {
        return this.#shardsLookup.load(block);
    }

    /**
     * Gets the transaction IDs (account, lt, hash) of the given block.
     * 
     * @param block Block ID of the target block
     * 
     * @param args Other arguments
     * 
     * @remarks
     * 
     * If `mode` is not passed in `args`, `mode` will be set according to other parameters.
     * 
     * For a list of modes, take a look at `FetchTransactionIDModes` and `ListBlockTransactionsModes`.
     * 
     * In the current official implementation of lite server, at most 255 transaction IDs will be returned per request.
     * 
     * @returns An object containing block ID, requested transaction count, whether there are more transactions, transaction IDs, and proof
     */
    listBlockTransactions = async (block: BlockID, args?: {
        mode?: number,
        count: number,
        after?: liteServer_transactionId3 | null | undefined,
        wantProof?: boolean | null | undefined,
        reverse?: boolean | null | undefined,
    }) => {
        let mode: number;
        if (args?.mode !== undefined) {
            mode = args?.mode;
        } else {
            mode = FetchTransactionIDModes.FetchAll;
            if (!!args?.wantProof) mode |= ListBlockTransactionsModes.WithProof;
            if (!!args?.reverse) mode |= ListBlockTransactionsModes.Reverse;
            if (!(args?.after === null || args?.after === undefined)) mode |= ListBlockTransactionsModes.WithAfter;
        }

        return await this.engine.query(Functions.liteServer_listBlockTransactions, {
            kind: 'liteServer.listBlockTransactions',
            id: blockIDToBlockIDExt(block),
            mode,
            count: args?.count ?? 100,
            reverseOrder: args?.reverse ?? null,
            after: args?.after ?? null,
            wantProof: args?.wantProof ?? null,
        }, { timeout: 5000 });
    }

    /**
     * Gets the information about a given masterchain block including its and its shards' block state and transactions
     * 
     * @param seqno Target masterchain block seqno
     * 
     * @remarks
     * 
     * Uses multiple lite server calls.
     * 
     * @returns An array of shard information with transaction IDs
     */
    getFullBlock = async (seqno: number) => {

        // MC Blocks
        let [mcBlockId, mcBlockPrevId] = await Promise.all([
            this.lookupBlockByID({ workchain: -1, shard: '-9223372036854775808', seqno: seqno }),
            this.lookupBlockByID({ workchain: -1, shard: '-9223372036854775808', seqno: seqno - 1 })
        ]);

        // Shards
        let [mcShards, mcShardsPrev] = await Promise.all([
            this.getAllShardsInfo(mcBlockId.id),
            this.getAllShardsInfo(mcBlockPrevId.id)
        ]);

        // Extract shards
        let shards: {
            workchain: number,
            seqno: number,
            shard: string
        }[] = [];
        shards.push({ seqno, workchain: -1, shard: '-9223372036854775808' });

        // Extract shards
        for (let wcs in mcShards.shards) {
            let wc = parseInt(wcs, 10);
            let psh = mcShardsPrev.shards[wcs] || {};

            for (let shs in mcShards.shards[wcs]) {
                let seqno = mcShards.shards[wcs][shs];
                let prevSeqno = psh[shs] || seqno;
                for (let s = prevSeqno + 1; s <= seqno; s++) {
                    shards.push({ seqno: s, workchain: wc, shard: shs });
                }
            }
        }

        // Fetch transactions and blocks
        let shards2 = await Promise.all(shards.map(async (shard) => {
            let blockId = await this.lookupBlockByID(shard);
            let transactions: liteServer_transactionId[] = [];
            let after: liteServer_transactionId3 | null = null;
            while (true) {
                let tr = await this.listBlockTransactions(blockId.id, {
                    count: 128,
                    mode: 1 + 2 + 4 + (after ? 128 : 0),
                    after
                });
                for (let t of tr.ids) {
                    transactions.push(t);
                }
                if (!tr.incomplete) {
                    break;
                }
                after = { kind: 'liteServer.transactionId3', account: tr.ids[tr.ids.length - 1].account!, lt: tr.ids[tr.ids.length - 1].lt! } as liteServer_transactionId3;
            }
            let mapped = transactions.map((t) => ({ hash: t.hash!, lt: t.lt!, account: t.account! }));

            return {
                ...shard,
                rootHash: blockId.id.rootHash,
                fileHash: blockId.id.fileHash,
                transactions: mapped
            }
        }));

        return {
            shards: shards2
        };
    }

    /**
     * Gets the validator stats at the given block.
     * 
     * @param block Block ID of the target block
     * 
     * @param limit Number of stats to return
     * 
     * @param args Other arguments
     * 
     * @remarks
     * 
     * In the current official implementation of lite server, `limit` will be set to 1000 if it is greater than 1000.
     * 
     * @returns An object containing block ID, mode, and the requested data
     */
    getValidatorStats = async (block: BlockID, limit: number, args?: {
        startAfter?: Buffer | null | undefined,
        modifiedAfter?: number | null | undefined,
        allowEqual?: boolean | null | undefined,
    }) => {
        let mode = GetValidatorStatsModes.None;
        if (!!args?.allowEqual) mode |= GetValidatorStatsModes.AllowEqual;
        if (!(args?.modifiedAfter === null || args?.modifiedAfter === undefined)) mode |= GetValidatorStatsModes.WithModifiedAfter;
        if (!(args?.startAfter === null || args?.startAfter === undefined)) mode |= GetValidatorStatsModes.WithStartAfter;

        return await this.engine.query(Functions.liteServer_getValidatorStats, {
            kind: 'liteServer.getValidatorStats',
            mode,
            limit,
            startAfter: args?.startAfter ?? null,
            modifiedAfter: args?.modifiedAfter ?? null,
            id: blockIDToBlockIDExt(block),
        }, { timeout: 5000 });
    }

    /**
     * Gets the data of the specified libraries at the last masterchain block.
     * 
     * @param libraryList Array of target libraries' hashes
     * 
     * @returns An object containing an array of libraries' hashes and data
     */
    getLibraries = async (libraryList: Buffer[]) => {
        return await this.engine.query(Functions.liteServer_getLibraries, {
            kind: 'liteServer.getLibraries',
            libraryList,
        }, { timeout: 5000 });
    }

    /**
     * Gets the proof links for the specified shard block.
     * 
     * @param block Block ID of the target block
     * 
     * @returns An object containing the masterchain block ID and the shard block proof links
     */
    getShardBlockProof = async (block: BlockID) => {
        return await this.engine.query(Functions.liteServer_getShardBlockProof, {
            kind: 'liteServer.getShardBlockProof',
            id: blockIDToBlockIDExt(block),
        }, { timeout: 5000 });
    }
}