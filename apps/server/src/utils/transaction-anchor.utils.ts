import { createHash } from 'crypto'
import * as anchor from '@coral-xyz/anchor'
import { Program } from '@coral-xyz/anchor'
import { HttpException, HttpStatus } from '@nestjs/common'
import { PublicKey, Transaction } from '@solana/web3.js'

/**
 * Build a transaction using Anchor program instructions
 * @param program Anchor program instance
 * @param methodName Name of the program method to call
 * @param args Arguments for the program method
 * @param accounts Object containing account public keys required by the method
 * @param feePayer Public key of the fee payer
 * @returns Transaction and serialized transaction string
 */
export async function buildAnchorTransaction({
	program,
	methodName,
	args = [],
	accounts,
	feePayer,
}: {
	program: Program
	methodName: string
	args?: any[]
	accounts: Record<string, PublicKey>
	feePayer: PublicKey
}): Promise<{
	transaction: Transaction
	serializedTransaction: string
	txId: string
}> {
	try {
		if (!program.methods[methodName]) {
			throw new Error(`Method "${methodName}" not found in program`)
		}

		// Build transaction using Anchor's fluent interface
		const tx = await program.methods[methodName](...args)
			.accounts(accounts)
			.transaction()

		// Set fee payer
		tx.feePayer = feePayer

		// Get recent blockhash
		const { blockhash } =
			await program.provider.connection.getLatestBlockhash('confirmed')
		tx.recentBlockhash = blockhash

		// Serialize transaction for client-side signing
		const serializedTx = tx.serialize({
			requireAllSignatures: false,
			verifySignatures: false,
		})

		// Create transaction ID hash for tracking
		const txId = createHash('sha256').update(serializedTx).digest('hex')

		return {
			transaction: tx,
			serializedTransaction: serializedTx.toString('base64'),
			txId,
		}
	} catch (error) {
		console.error('Error building Anchor transaction:', error)

		let errorMessage = 'Failed to build transaction'
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
 * Send a signed transaction
 * @param connection Solana connection
 * @param signedTransaction Base64 encoded signed transaction
 * @returns Transaction signature
 */
export async function sendSignedTransaction(
	connection: anchor.web3.Connection,
	signedTransaction: string,
): Promise<string> {
	try {
		// Convert base64 string to buffer
		const rawTransaction = Buffer.from(signedTransaction, 'base64')

		// Send transaction
		const txId = await connection.sendRawTransaction(rawTransaction, {
			skipPreflight: false,
			preflightCommitment: 'confirmed',
		})

		// Wait for confirmation
		const confirmation = await connection.confirmTransaction(
			{
				signature: txId,
				...(await connection.getLatestBlockhash()),
			},
			'confirmed',
		)

		if (confirmation.value.err) {
			throw new Error(
				`Transaction failed: ${confirmation.value.err.toString()}`,
			)
		}

		return txId
	} catch (error) {
		console.error('Error sending transaction:', error)

		let errorMessage = 'Failed to send transaction'
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
 * Helper function to convert string amount to anchor BN
 */
export function toBN(amount: string | number): anchor.BN {
	try {
		return new anchor.BN(amount)
	} catch (error) {
		console.error('Error converting to BN:', error)
		return new anchor.BN(0)
	}
}

/**
 * Helper function to convert BN to string
 */
export function fromBN(bn: anchor.BN | null | undefined): string {
	if (!bn) return '0'
	return bn.toString()
}
