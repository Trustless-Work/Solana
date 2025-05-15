import { createHash } from 'crypto'
import * as anchor from '@coral-xyz/anchor'
import { Program } from '@coral-xyz/anchor'
import { HttpException, HttpStatus } from '@nestjs/common'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'

/**
 * Create a program instance using the IDL from programs/solana-tl
 */
export function createAnchorProgram(
	programId: string,
	connection: Connection,
	wallet?: anchor.Wallet | null,
): Program {
	try {
		// Import the IDL dynamically
		// We're assuming the IDL is available in the programs/solana-tl package
		const { EscrowIDL } = require('@programs/solana-tl')

		// Create provider with optional wallet
		const provider = new anchor.AnchorProvider(connection, wallet || null, {
			commitment: 'confirmed',
		})

		// Create program
		return new anchor.Program(EscrowIDL, new PublicKey(programId), provider)
	} catch (error) {
		console.error('Error creating Anchor program:', error)
		throw new HttpException(
			{
				status: HttpStatus.INTERNAL_SERVER_ERROR,
				message: 'Failed to create Anchor program',
			},
			HttpStatus.INTERNAL_SERVER_ERROR,
		)
	}
}

/**
 * Create an unsigned transaction from an Anchor program method call
 */
export async function createUnsignedAnchorTransaction({
	program,
	method,
	args,
	accounts,
	feePayer,
}: {
	program: Program
	method: string
	args: any[]
	accounts: Record<string, PublicKey>
	feePayer: PublicKey
}): Promise<{
	transaction: Transaction
	serializedTransaction: string
	txHashForQueue: string
}> {
	try {
		// Validate method exists on program
		if (!program.methods[method]) {
			throw new Error(`Method "${method}" not found on program`)
		}

		// Build transaction using Anchor's fluent interface
		const tx = await program.methods[method](...args)
			.accounts(accounts)
			.transaction()

		// Set fee payer
		tx.feePayer = feePayer

		// Get recent blockhash
		const { blockhash } =
			await program.provider.connection.getLatestBlockhash('confirmed')
		tx.recentBlockhash = blockhash

		// Serialize for client-side signing
		const serializedTx = tx.serialize({
			requireAllSignatures: false,
			verifySignatures: false,
		})

		// Create a hash for queue tracking
		const txHashForQueue = createHash('sha256')
			.update(serializedTx)
			.digest('hex')

		return {
			transaction: tx,
			serializedTransaction: serializedTx.toString('base64'),
			txHashForQueue,
		}
	} catch (error) {
		console.error('Error creating unsigned Anchor transaction:', error)

		let errorMessage = 'Failed to create transaction'
		if (error instanceof Error) {
			errorMessage = error.message
		}
		if (error.logs) {
			errorMessage += ` Program logs: ${error.logs.join(', ')}`
		}

		throw new HttpException(
			{ status: HttpStatus.BAD_REQUEST, message: errorMessage },
			HttpStatus.BAD_REQUEST,
		)
	}
}

/**
 * Process a signed transaction
 */
export async function processSignedAnchorTransaction({
	serializedSignedTransaction,
	connection,
	queueKey,
}: {
	serializedSignedTransaction: string
	connection: Connection
	queueKey: string
}): Promise<string> {
	try {
		// Convert base64 to buffer
		const transactionBuffer = Buffer.from(serializedSignedTransaction, 'base64')

		// Send transaction to network
		const signature = await connection.sendRawTransaction(transactionBuffer, {
			skipPreflight: false,
			preflightCommitment: 'confirmed',
		})

		// Confirm the transaction
		await connection.confirmTransaction(
			{
				signature,
				...(await connection.getLatestBlockhash()),
			},
			'confirmed',
		)

		return signature
	} catch (error) {
		console.error('Error sending signed Anchor transaction:', error)

		let errorMessage = 'Failed to send transaction'
		if (error instanceof Error) {
			errorMessage = error.message
		}
		if (error.logs) {
			errorMessage += ` Program logs: ${error.logs.join(', ')}`
		}

		throw new HttpException(
			{ status: HttpStatus.BAD_REQUEST, message: errorMessage },
			HttpStatus.BAD_REQUEST,
		)
	}
}

/**
 * Fetch and deserialize an account using Anchor's typed account fetching
 */
export async function fetchAnchorAccount<T>({
	program,
	accountAddress,
	accountType,
}: {
	program: Program
	accountAddress: PublicKey
	accountType: string
}): Promise<T> {
	try {
		if (!program.account[accountType]) {
			throw new Error(`Account type "${accountType}" not found on program`)
		}

		return await program.account[accountType].fetch(accountAddress)
	} catch (error) {
		console.error(`Error fetching ${accountType} account:`, error)

		let errorMessage = `Failed to fetch ${accountType} account`
		if (error instanceof Error) {
			errorMessage = error.message
		}

		throw new HttpException(
			{ status: HttpStatus.BAD_REQUEST, message: errorMessage },
			HttpStatus.BAD_REQUEST,
		)
	}
}

/**
 * Convert Anchor.BN to string safely
 */
export function bnToString(bn: anchor.BN | null | undefined): string {
	if (!bn) return '0'
	return bn.toString()
}

/**
 * Convert string to Anchor.BN safely
 */
export function stringToBN(str: string): anchor.BN {
	try {
		return new anchor.BN(str)
	} catch (e) {
		return new anchor.BN(0)
	}
}
