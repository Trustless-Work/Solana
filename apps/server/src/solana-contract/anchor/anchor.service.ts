import * as anchor from '@coral-xyz/anchor'
import { Program } from '@coral-xyz/anchor'
import { Injectable } from '@nestjs/common'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { apiConfig } from 'src/config/api.config'

@Injectable()
export class AnchorService {
	private readonly connection: Connection
	private readonly escrowProgramId: PublicKey

	constructor() {
		// Initialize connection
		this.connection = new Connection(apiConfig.solanaServerURL, 'confirmed')

		// Set program IDs from config
		this.escrowProgramId = new PublicKey(apiConfig.solanaProgramId)

		// Load IDL
		try {
			// The IDL is available in the @programs/solana-tl package
			const { EscrowIDL } = require('@programs/solana-tl')
			this._escrowIdl = EscrowIDL
		} catch (error) {
			console.error('Failed to load IDL from package:', error)
		}
	}

	/**
	 * Get an AnchorProvider with optional wallet
	 */
	getProvider(wallet?: anchor.Wallet): anchor.AnchorProvider {
		return new anchor.AnchorProvider(this.connection, wallet || null, {
			commitment: 'confirmed',
		})
	}

	/**
	 * Create a wallet from a private key
	 */
	createWallet(privateKey: Uint8Array): anchor.Wallet {
		const keypair = Keypair.fromSecretKey(privateKey)
		return new anchor.Wallet(keypair)
	}

	/**
	 * Get the escrow program with optional wallet
	 */
	getEscrowProgram(wallet?: anchor.Wallet): Program {
		const provider = this.getProvider(wallet)
		return new anchor.Program(this._escrowIdl, this.escrowProgramId, provider)
	}

	/**
	 * Get the connection
	 */
	getConnection(): Connection {
		return this.connection
	}

	/**
	 * Get the escrow program ID
	 */
	getEscrowProgramId(): PublicKey {
		return this.escrowProgramId
	}

	// Private fields
	private _escrowIdl: any
}
