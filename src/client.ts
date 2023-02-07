import { Address, Cell, loadShardStateUnsplit, CurrencyCollection, loadAccount, Account } from "ton-core";
import { LiteEngine } from "./engines/engine";
import { parseShards } from "./parser/parseShards";
import { Functions, liteServer_blockHeader, liteServer_transactionId, liteServer_transactionId3, tonNode_blockIdExt } from "./schema";
import DataLoader from "dataloader";
import { crc16 } from "./utils/crc16";

//
// Ops
//

const lookupBlockByID = async (engine: LiteEngine, props: { seqno: number, shard: string, workchain: number }) => {
    return await engine.query(Functions.liteServer_lookupBlock, {
        kind: 'liteServer.lookupBlock',
        mode: 1,
        id: {
            kind: 'tonNode.blockId',
            seqno: props.seqno,
            shard: props.shard,
            workchain: props.workchain
        },
        lt: null,
        utime: null
    }, { timeout: 5000 });
}

const lookupBlockByUtime = async (engine: LiteEngine, props: { shard: string, workchain: number, utime: number }) => {
    return await engine.query(Functions.liteServer_lookupBlock, {
        kind: 'liteServer.lookupBlock',
        mode: 4,
        id: {
            kind: 'tonNode.blockId',
            seqno: 0,
            shard: props.shard,
            workchain: props.workchain
        },
        lt: null,
        utime: props.utime
    }, { timeout: 5000 });
}

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
const getAllShardsInfo = async (engine: LiteEngine, props: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
    let res = (await engine.query(Functions.liteServer_getAllShardsInfo, { kind: 'liteServer.getAllShardsInfo', id: props }, { timeout: 5000 }));
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

const getBlockHeader = async (engine: LiteEngine, props: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
    return await engine.query(Functions.liteServer_getBlockHeader, {
        kind: 'liteServer.getBlockHeader',
        mode: 1,
        id: {
            kind: 'tonNode.blockIdExt',
            seqno: props.seqno,
            shard: props.shard,
            workchain: props.workchain,
            rootHash: props.rootHash,
            fileHash: props.fileHash
        }
    }, { timeout: 5000 });
}

type BlockLookupIDRequest = { seqno: number, shard: string, workchain: number, mode: 'id' }
type BlockLookupUtimeRequest = { shard: string, workchain: number, mode: 'utime', utime: number }


export class LiteClient {
    readonly engine: LiteEngine;
    #blockLockup: DataLoader<BlockLookupIDRequest | BlockLookupUtimeRequest, liteServer_blockHeader, string>;
    #shardsLockup: DataLoader<{ seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, AllShardsResponse, string>;
    #blockHeader: DataLoader<{ seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, liteServer_blockHeader, string>;

    constructor(opts: { engine: LiteEngine, batchSize?: number | undefined | null }) {
        this.engine = opts.engine;
        let batchSize = typeof opts.batchSize === 'number' ? opts.batchSize : 100;

        this.#blockLockup = new DataLoader(async (s) => {
            return await Promise.all(s.map((v) => {
                if (v.mode === 'utime') {
                    return lookupBlockByUtime(this.engine, v);
                }
                return lookupBlockByID(this.engine, v);
            }));
        }, { maxBatchSize: batchSize, cacheKeyFn: (s) => {
            if (s.mode === 'id') {
                return s.workchain + '::' + s.shard + '::' + s.seqno;
            } else {
                return s.workchain + '::' + s.shard + '::utime-' + s.utime;
            }
        }});

        this.#blockHeader = new DataLoader(async (s) => {
            return await Promise.all(s.map((v) => getBlockHeader(this.engine, v)));
        }, { maxBatchSize: batchSize, cacheKeyFn: (s) => s.workchain + '::' + s.shard + '::' + s.seqno });

        this.#shardsLockup = new DataLoader<{ seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, AllShardsResponse, string>(async (s) => {
            return await Promise.all(s.map((v) => getAllShardsInfo(this.engine, v)));
        }, { maxBatchSize: batchSize, cacheKeyFn: (s) => s.workchain + '::' + s.shard + '::' + s.seqno });
    }

    //
    // Sending
    //

    sendMessage = async (src: Buffer) => {
        let res = await this.engine.query(Functions.liteServer_sendMessage, { kind: 'liteServer.sendMessage', body: src }, { timeout: 5000 });
        return {
            status: res.status
        };
    }

    //
    // State
    //

    getMasterchainInfo = async () => {
        return this.engine.query(Functions.liteServer_getMasterchainInfo, { kind: 'liteServer.masterchainInfo' }, { timeout: 5000 });
    }

    getMasterchainInfoExt = async () => {
        return this.engine.query(Functions.liteServer_getMasterchainInfoExt, { kind: 'liteServer.masterchainInfoExt', mode: 0 }, { timeout: 5000 });
    }

    getCurrentTime = async () => {
        return (await this.engine.query(Functions.liteServer_getTime, { kind: 'liteServer.getTime' }, { timeout: 5000 })).now;
    }

    getVersion = async () => {
        return (await this.engine.query(Functions.liteServer_getVersion, { kind: 'liteServer.getVersion' }, { timeout: 5000 }));
    }

    getConfig = async (block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
        let res = await this.engine.query(Functions.liteServer_getConfigAll, {
            kind: 'liteServer.getConfigAll',
            id: {
                kind: 'tonNode.blockIdExt',
                seqno: block.seqno,
                shard: block.shard,
                workchain: block.workchain,
                fileHash: block.fileHash,
                rootHash: block.rootHash
            },
            mode: 0
        }, { timeout: 5000 });

        const configProof = Cell.fromBoc(res.configProof)[0];
        const configCell = configProof.refs[0];
        const cs = configCell.beginParse();
        const shardState = loadShardStateUnsplit(cs);
        if (!shardState.extras) {
            throw Error('Invalid response');
        }
        return shardState.extras;
    };

    //
    // Account
    //

    getAccountState = async (src: Address, block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, timeout: number = 5000) => {
        let res = (await this.engine.query(Functions.liteServer_getAccountState, {
            kind: 'liteServer.getAccountState',
            id: {
                kind: 'tonNode.blockIdExt',
                seqno: block.seqno,
                shard: block.shard,
                workchain: block.workchain,
                fileHash: block.fileHash,
                rootHash: block.rootHash
            },
            account: {
                kind: 'liteServer.accountId',
                workchain: src.workChain,
                id: src.hash
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
                let hashId = BigInt('0x' + src.hash.toString('hex'));
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

    getAccountStatePrunned = async (src: Address, block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, timeout: number = 5000) => {
        let res = (await this.engine.query(Functions.liteServer_getAccountStatePrunned, {
            kind: 'liteServer.getAccountStatePrunned',
            id: {
                kind: 'tonNode.blockIdExt',
                seqno: block.seqno,
                shard: block.shard,
                workchain: block.workchain,
                fileHash: block.fileHash,
                rootHash: block.rootHash
            },
            account: {
                kind: 'liteServer.accountId',
                workchain: src.workChain,
                id: src.hash
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

    getAccountTransaction = async (src: Address, lt: string, block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
        return await this.engine.query(Functions.liteServer_getOneTransaction, {
            kind: 'liteServer.getOneTransaction',
            id: block,
            account: {
                kind: 'liteServer.accountId',
                workchain: src.workChain,
                id: src.hash
            },
            lt: lt
        }, { timeout: 5000 });
    }

    getAccountTransactions = async (src: Address, lt: string, hash: Buffer, count: number) => {
        let loaded = await this.engine.query(Functions.liteServer_getTransactions, {
            kind: 'liteServer.getTransactions',
            count,
            account: {
                kind: 'liteServer.accountId',
                workchain: src.workChain,
                id: src.hash
            },
            lt: lt,
            hash: hash
        }, { timeout: 5000 });
        return {
            ids: loaded.ids,
            transactions: loaded.transactions
        };
    }

    runMethod = async (src: Address, method: string, params: Buffer, block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
        let res = await this.engine.query(Functions.liteServer_runSmcMethod, {
            kind: 'liteServer.runSmcMethod',
            mode: 4,
            id: {
                kind: 'tonNode.blockIdExt',
                seqno: block.seqno,
                shard: block.shard,
                workchain: block.workchain,
                rootHash: block.rootHash,
                fileHash: block.fileHash
            },
            account: {
                kind: 'liteServer.accountId',
                workchain: src.workChain,
                id: src.hash
            },
            methodId: ((crc16(method) & 0xffff) | 0x10000) + '',
            params
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

    lookupBlockByID = async (block: { seqno: number, shard: string, workchain: number }) => {
        return await this.#blockLockup.load({ ...block, mode: 'id' });
    }

    lookupBlockByUtime = async (block: { shard: string, workchain: number, utime: number }) => {
        return await this.#blockLockup.load({ ...block, mode: 'utime' });
    }

    getBlockHeader = async (block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
        return this.#blockHeader.load(block);
    }

    getAllShardsInfo = async (block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
        return this.#shardsLockup.load(block);
    }

    listBlockTransactions = async (block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, args?: {
        mode: number,
        count: number,
        after?: liteServer_transactionId3 | null | undefined,
        wantProof?: boolean
    }) => {

        let mode = args?.mode || 1 + 2 + 4;
        let count = args?.count || 100;
        let after: liteServer_transactionId3 | null = args && args.after ? args.after : null;

        return await this.engine.query(Functions.liteServer_listBlockTransactions, {
            kind: 'liteServer.listBlockTransactions',
            id: {
                kind: 'tonNode.blockIdExt',
                seqno: block.seqno,
                shard: block.shard,
                workchain: block.workchain,
                rootHash: block.rootHash,
                fileHash: block.fileHash
            },
            mode,
            count,
            reverseOrder: null,
            after,
            wantProof: null
        }, { timeout: 5000 });
    }

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
}