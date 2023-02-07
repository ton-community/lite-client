import { xed25519_ecdh } from '@tonstack/xed25519'

class ADNLKeys {
    private _public: Uint8Array
    private _shared: Uint8Array

    constructor(peerPublicKey: Uint8Array) {
        const keys = xed25519_ecdh(peerPublicKey)

        this._public = keys.public
        this._shared = keys.shared
    }

    public get public(): Uint8Array {
        return new Uint8Array(this._public)
    }

    public get shared(): Uint8Array {
        return new Uint8Array(this._shared)
    }
}

export { ADNLKeys }
