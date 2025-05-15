import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { AllbridgeService } from '@packages/allbridge'
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js'
import type {
	ApiResponse,
	EscrowCamelCaseResponse,
} from 'src/interfaces/response.interface'
import { mapErrorCodeToMessage } from 'src/utils/errors.utils'
import {
	buildAnchorTransaction,
	fromBN,
	toBN,
} from 'src/utils/transaction-anchor.utils'
import { AnchorService } from '../anchor/anchor.service'
import { HelperService } from '../helper/helper.service'
import { PendingWriteQueueService } from '../queue/pending-write-queue.service'
import { EscrowDto } from './Dto/escrow.dto'
import { EscrowFirestoreService } from './firestore-services/escrow-firestore.service'

interface FundEscrowSwapData {
	originalCurrency: string
	usdcAmount: string
	conversionRate: string
	conversionTimestamp: number
}

@Injectable()
export class EscrowAnchorService {
	private solanaServer: Connection
	private allBridgeService = new AllbridgeService()

	constructor(
		private pendingWriteQueue: PendingWriteQueueService,
		private readonly escrowFirestoreService: EscrowFirestoreService,
		private readonly helperService: HelperService,
		private readonly anchorService: AnchorService,
	) {
		this.solanaServer = this.helperService.getServerConnection()
	}

	/**
	 * Fund an escrow account with a specified amount
	 */
	async fundEscrow(
		contractId: string,
		signer: string,
		amount: string,
	): Promise<ApiResponse> {
		try {
			// Convert addresses to PublicKeys
			const escrowAccount = new PublicKey(contractId)
			const signerPublicKey = new PublicKey(signer)

			// Get the Anchor program instance
			const program = this.anchorService.getEscrowProgram()

			// Convert amount string to BN for Anchor
			const amountBN = toBN(amount)

			// Build transaction using Anchor
			const { serializedTransaction, txId } = await buildAnchorTransaction({
				program,
				methodName: 'fundEscrow',
				args: [amountBN],
				accounts: {
					escrowAccount,
					signer: signerPublicKey,
					systemProgram: SystemProgram.programId,
				},
				feePayer: signerPublicKey,
			})

			// Add to the pending write queue
			this.pendingWriteQueue.add(txId, {
				type: 'FUND_ESCROW',
				payload: { contractId, amount },
			})

			// Return the transaction for signing by the client
			return {
				status: 'success',
				unsignedTransaction: serializedTransaction,
			}
		} catch (error) {
			console.error('Error in fundEscrow:', error)

			const customError = mapErrorCodeToMessage(error.message)
			throw new HttpException(
				{
					status: HttpStatus.BAD_REQUEST,
					message: customError?.message || error.message,
				},
				HttpStatus.BAD_REQUEST,
			)
		}
	}

	/**
	 * Change dispute flag for an escrow
	 */
	async changeDisputeFlag(
		contractId: string,
		signer: string,
	): Promise<ApiResponse> {
		try {
			// Convert addresses to PublicKeys
			const escrowAccount = new PublicKey(contractId)
			const signerPublicKey = new PublicKey(signer)

			// Get the Anchor program instance
			const program = this.anchorService.getEscrowProgram()

			// Build transaction using Anchor
			const { serializedTransaction, txId } = await buildAnchorTransaction({
				program,
				methodName: 'changeDisputeFlag',
				args: [],
				accounts: {
					signer: signerPublicKey,
					escrowAccount,
				},
				feePayer: signerPublicKey,
			})

			// Add to the pending write queue
			this.pendingWriteQueue.add(txId, {
				type: 'START_DISPUTE',
				payload: { contractId },
			})

			// Return the transaction for signing by the client
			return {
				status: 'success',
				unsignedTransaction: serializedTransaction,
			}
		} catch (error) {
			console.error('Error in changeDisputeFlag:', error)

			let errorMessage = 'Failed to create dispute flag change transaction'
			if (error instanceof Error) {
				errorMessage = error.message
			}
			if (error.logs) {
				errorMessage += ` Program logs: ${error.logs.join(', ')}`
			}

			throw new HttpException(
				{
					status: HttpStatus.BAD_REQUEST,
					message: errorMessage,
				},
				HttpStatus.BAD_REQUEST,
			)
		}
	}

	/**
	 * Update escrow properties
	 */
	async updateEscrowByContractID(
		contractId: string,
		signer: string,
		escrow: EscrowDto,
	): Promise<ApiResponse> {
		try {
			// Convert addresses to PublicKeys
			const platformSignerPubkey = new PublicKey(signer)
			const escrowAccountPubkey = new PublicKey(contractId)

			// Get the Anchor program instance
			const program = this.anchorService.getEscrowProgram()

			// Convert the DTO to the structure expected by Anchor
			// This will depend on your specific escrow data structure in the IDL
			const escrowData = {
				// Map from your DTO to the Anchor expected format
				// Example fields - adjust based on your actual schema
				title: escrow.title || '',
				description: escrow.description || '',
				status: escrow.status || 'PENDING',
				amount: toBN(escrow.amount || '0'),
				// Add other fields as needed based on your program's IDL
			}

			// Build transaction using Anchor
			const { serializedTransaction, txId } = await buildAnchorTransaction({
				program,
				methodName: 'changeEscrowProperties',
				args: [escrowData],
				accounts: {
					platformSigner: platformSignerPubkey,
					escrowAccount: escrowAccountPubkey,
					escrowTokenAccount: new PublicKey(
						escrow.tokenAccount || escrowAccountPubkey.toString(),
					),
				},
				feePayer: platformSignerPubkey,
			})

			// Update Firestore
			await this.escrowFirestoreService.updateEscrowData(
				contractId,
				signer,
				escrow,
			)

			// Add to the pending write queue
			this.pendingWriteQueue.add(txId, {
				type: 'EDIT_ESCROW',
				payload: { contractId, signer, escrow },
			})

			// Return the transaction for signing by the client
			return {
				status: 'success',
				unsignedTransaction: serializedTransaction,
			}
		} catch (error) {
			console.error('Error in updateEscrowByContractID:', error)

			let errorMessage = 'Failed to create escrow update transaction'
			if (error instanceof Error) {
				errorMessage = error.message
			}
			if (error.logs) {
				errorMessage += ` Program logs: ${error.logs.join(', ')}`
			}

			throw new HttpException(
				{
					status: HttpStatus.BAD_REQUEST,
					message: errorMessage,
				},
				HttpStatus.BAD_REQUEST,
			)
		}
	}

	/**
	 * Distribute escrow earnings
	 */
	async distributeEscrowEarnings(
		contractId: string,
		releaseSigner: string,
	): Promise<ApiResponse> {
		try {
			// Convert addresses to PublicKeys
			const escrowAccount = new PublicKey(contractId)
			const signerPublicKey = new PublicKey(releaseSigner)

			// Get the Anchor program instance
			const program = this.anchorService.getEscrowProgram()

			// Build transaction using Anchor
			const { serializedTransaction, txId } = await buildAnchorTransaction({
				program,
				methodName: 'distributeEscrowEarnings',
				args: [],
				accounts: {
					signer: signerPublicKey,
					escrowAccount,
					systemProgram: SystemProgram.programId,
				},
				feePayer: signerPublicKey,
			})

			// Add to the pending write queue
			this.pendingWriteQueue.add(txId, {
				type: 'MARK_RELEASED',
				payload: { contractId },
			})

			// Return the transaction for signing by the client
			return {
				status: 'success',
				unsignedTransaction: serializedTransaction,
			}
		} catch (error) {
			console.error('Error in distributeEscrowEarnings:', error)

			let errorMessage = 'Failed to create distribute earnings transaction'
			if (error instanceof Error) {
				errorMessage = error.message
			}
			if (error.logs) {
				errorMessage += ` Program logs: ${error.logs.join(', ')}`
			}

			throw new HttpException(
				{
					status: HttpStatus.BAD_REQUEST,
					message: errorMessage,
				},
				HttpStatus.BAD_REQUEST,
			)
		}
	}

	/**
	 * Get escrow by contract ID
	 * Fetches the escrow data using Anchor's typed account fetching
	 */
	async getEscrowByContractID(
		signer: string,
		contractId: string,
	): Promise<EscrowCamelCaseResponse> {
		try {
			// Convert address to PublicKey
			const escrowAccountPubkey = new PublicKey(contractId)

			// Get the Anchor program
			const program = this.anchorService.getEscrowProgram()

			// Fetch the account data using Anchor's typed fetching
			const escrowAccount =
				await program.account.escrowAccount.fetch(escrowAccountPubkey)

			// Convert Anchor account data to your API response type
			// The exact mapping depends on your specific Anchor IDL and response type
			return {
				approver: escrowAccount.approver.toString(),
				receiver: escrowAccount.receiver.toString(),
				amount: fromBN(escrowAccount.amount),
				title: escrowAccount.title || '',
				description: escrowAccount.description || '',
				status: escrowAccount.status || 'PENDING',
				disputeFlag: escrowAccount.disputeFlag || false,
				// Map other fields from escrowAccount to your EscrowCamelCaseResponse type
				// This is just an example and needs to be adjusted to your specific data structures
				trustlineDecimals: 6, // Default for USDC
			}
		} catch (error) {
			console.error('Error in getEscrowByContractID:', error)

			let errorMessage = 'Failed to fetch escrow data'
			if (error instanceof Error) {
				errorMessage = error.message
			}
			if (error.logs) {
				errorMessage += ` Program logs: ${error.logs.join(', ')}`
			}

			throw new HttpException(
				{
					status: HttpStatus.BAD_REQUEST,
					message: errorMessage,
				},
				HttpStatus.BAD_REQUEST,
			)
		}
	}
}
