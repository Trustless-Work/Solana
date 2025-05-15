import { createHash } from 'node:crypto'
import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { AllbridgeService } from '@packages/allbridge'
import * as borsh from '@project-serum/borsh'
import {
	Connection,
	PublicKey,
	SystemProgram,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js'
import * as StellarSDK from '@stellar/stellar-sdk'
import { apiConfig } from 'src/config/api.config'
import type {
	ApiResponse,
	EscrowCamelCaseResponse,
} from 'src/interfaces/response.interface'
import { mapErrorCodeToMessage } from 'src/utils/errors.utils'
import { adjustPricesToMicroUSDC } from 'src/utils/parse.utils'
import { buildTransaction } from 'src/utils/transaction.utils'
import { AnchorService } from '../anchor/anchor.service'
import type { HelperService } from '../helper/helper.service'
import type { PendingWriteQueueService } from '../queue/pending-write-queue.service'
import type { EscrowDto } from './Dto/escrow.dto'
import type { EscrowFirestoreService } from './firestore-services/escrow-firestore.service'

interface FundEscrowSwapData {
	originalCurrency: string
	usdcAmount: string
	conversionRate: string
	conversionTimestamp: number
}

@Injectable()
export class EscrowService {
	private horizonServer: StellarSDK.Horizon.Server
	private sorobanServer: StellarSDK.SorobanRpc.Server
	private trustlessContractId: string
	private trustlessAddress: string
	private usdcPublicAddress: string
	private solanaServer: Connection
	private allBridgeService = new AllbridgeService()

	constructor(
		private pendingWriteQueue: PendingWriteQueueService,
		private readonly escrowFirestoreService: EscrowFirestoreService,
		private readonly helperService: HelperService,
		private readonly anchorService: AnchorService,
	) {
		this.horizonServer = new StellarSDK.Horizon.Server(
			`${process.env.SERVER_URL}`,
			{ allowHttp: true },
		)
		this.sorobanServer = new StellarSDK.SorobanRpc.Server(
			`${process.env.SOLANA_SERVER_URL}`,
			{ allowHttp: true },
		)
		this.trustlessContractId = apiConfig.trustlessContractId
		this.trustlessAddress = apiConfig.trustlessAddress
		this.usdcPublicAddress = this.helperService.usdcTokenPublic
		// * We can use the connection from the helper service or create a new one by using
		// * same function from same helper service if we need to
		// ? i.e.:
		// this.solanaServer = this.helperService.getServerConnection(customOptions)
		this.solanaServer = this.helperService.solanaServer
	}

	private async getSolanaAddress(
		signer: string,
	): Promise<Buffer<ArrayBufferLike> | null> {
		const publicKey = new PublicKey(signer)
		try {
			const accountInfo = await this.solanaServer.getAccountInfo(publicKey)

			if (!accountInfo?.data) throw new Error('Account not found')

			return accountInfo?.data
		} catch (e) {
			console.error(`Failed to deserialize account data for ${signer}:`, e)
			return null
		}
	}

	async fundEscrow(
		contractId: string,
		signer: string,
		amount: string,
		swapData?: FundEscrowSwapData,
	): Promise<ApiResponse> {
		try {
			const escrowAmount = swapData?.usdcAmount || amount
			let unsignedConversionTransaction = ''

			const solanaAddress = this.getSolanaAddress(signer)
			// If not USDC, perform swap via Allbridge
			if (swapData && !solanaAddress) {
				const swapResult = await this.allBridgeService.swapToUSDC({
					fromToken: swapData.originalCurrency,
					amount,
					userAddress: signer,
					walletType: 'stellar',
				})
				unsignedConversionTransaction = swapResult.txHash
			}
			// TODO: Double check the swap flow with the team. -Andler.
			if (!swapData && !solanaAddress) {
				const swapResult = await this.allBridgeService.swapToUSDC({
					fromToken: 'USDT',
					amount,
					userAddress: signer,
					walletType: 'evm',
				})
				unsignedConversionTransaction = swapResult.txHash
			}

			const contract = new PublicKey(contractId)
			const account = new PublicKey(signer)
			const { trustlineDecimals } = await this.getEscrowByContractID(
				signer,
				contractId,
			)
			const adjustedPrice = adjustPricesToMicroUSDC({
				price: escrowAmount,
				decimals: trustlineDecimals,
			})
			const operationData = Buffer.from(
				borsh
					.struct([
						borsh.str('action'),
						borsh.str('contract_id'),
						borsh.u128('price'),
					])
					.encode({
						action: 'fund_escrow',
						price: adjustedPrice,
						signer,
					}),
			)
			const transaction = await buildTransaction({
				account,
				connection: this.solanaServer,
				operations: [
					new TransactionInstruction({
						keys: [
							{ pubkey: account, isSigner: true, isWritable: true },
							{ pubkey: contract, isSigner: false, isWritable: true },
							{
								pubkey: SystemProgram.programId,
								isSigner: false,
								isWritable: false,
							},
						],
						programId: new PublicKey(this.trustlessContractId),
						data: operationData,
					}),
				],
			})
			// ! Serialize the transaction to be signed by the client
			const serializedTransaction = transaction.serialize({
				requireAllSignatures: false,
				verifySignatures: false,
			})
			// Create a compatible transaction object that provides the same interface
			const preparedTransaction = {
				hash: () => createHash('sha256').update(serializedTransaction).digest(),
				toXDR: () => serializedTransaction.toString('base64'),
			}
			const txHash = preparedTransaction.hash().toString('hex')

			this.pendingWriteQueue.add(txHash, {
				type: 'SET_BALANCE',
				payload: {
					contractId,
					amount: escrowAmount,
					swapData: {
						...swapData,
						originalAmount: amount,
						unsignedConversionTransaction,
					},
				},
			})

			return {
				status: 'SUCCESS',
				unsignedTransaction: preparedTransaction.toXDR(),
				unsignedConversionTransaction,
			}
		} catch (error) {
			if (error.message.includes('HostError: Error(Contract, #')) {
				const errorCode = error.message.match(/Error\(Contract, #(\d+)\)/)?.[1]
				const errorMessage = mapErrorCodeToMessage(errorCode)
				throw new HttpException(
					{ status: HttpStatus.BAD_REQUEST, message: errorMessage },
					HttpStatus.BAD_REQUEST,
				)
			}

			throw new HttpException(
				{ status: HttpStatus.INTERNAL_SERVER_ERROR, message: error.message },
				HttpStatus.INTERNAL_SERVER_ERROR,
			)
		}
	}

	/**************************************************************************
	 *
	 *
	 * ! ALL BELOW METHODS ARE STELLAR SPECIFIC... UPDATE REQUIRED TO SOLANA.
	 * ! (ALMOST) EVERYTHING BROKEN AFTER THIS LINE
	 *
	 *
	 *************************************************************************/

	async sendFundsWithMemo(
		contractId: string,
		signer: string,
	): Promise<ApiResponse> {
		const asset = new StellarSDK.Asset('USDC', this.usdcPublicAddress)
		const { receiverMemo, receiver } = await this.getEscrowByContractID(
			signer,
			contractId,
		)
		const currentBalance = await this.helperService.getMultipleEscrowBalance(
			signer,
			[contractId],
		)

		const paymentOperation = StellarSDK.Operation.payment({
			amount: currentBalance[0].balance.toString(),
			destination: receiver,
			asset,
			source: contractId,
		})

		const accountInfo = await this.sorobanServer.getAccount(signer)

		const transaction = new StellarSDK.TransactionBuilder(accountInfo, {
			fee: StellarSDK.BASE_FEE,
			networkPassphrase: StellarSDK.Networks.TESTNET,
		})
			.addOperation(paymentOperation)
			.addMemo(StellarSDK.Memo.text(receiverMemo.toString()))
			.setTimeout(30)
			.build()

		return {
			status: StellarSDK.rpc.Api.GetTransactionStatus.SUCCESS,
			unsignedTransaction: transaction.toXDR(),
		}
	}

	async distributeEscrowEarnings(
		contractId: string,
		releaseSigner: string,
	): Promise<ApiResponse> {
		try {
			const contract = new StellarSDK.Contract(contractId)
			const account = await this.sorobanServer.getAccount(releaseSigner)

			const operations = [
				contract.call(
					'distribute_escrow_earnings',
					StellarSDK.Address.fromString(releaseSigner).toScVal(),
					StellarSDK.Address.fromString(this.trustlessAddress).toScVal(),
				),
			]

			const transaction = buildTransaction(account, operations)
			const preparedTransaction =
				await this.sorobanServer.prepareTransaction(transaction)

			const txHash = preparedTransaction.hash().toString('hex')

			this.pendingWriteQueue.add(txHash, {
				type: 'MARK_RELEASED',
				payload: { contractId },
			})

			return {
				status: StellarSDK.rpc.Api.GetTransactionStatus.SUCCESS,
				unsignedTransaction: preparedTransaction.toXDR(),
			}
		} catch (error) {
			if (error.message.includes('HostError: Error(Contract, #')) {
				const errorCode = error.message.match(/Error\(Contract, #(\d+)\)/)?.[1]
				const errorMessage = mapErrorCodeToMessage(errorCode)
				throw new HttpException(
					{ status: HttpStatus.BAD_REQUEST, message: errorMessage },
					HttpStatus.BAD_REQUEST,
				)
			}

			throw error
		}
	}

	async resolvingDisputes(
		contractId: string,
		disputeResolver: string,
		approverFunds: string,
		receiverFunds: string,
	): Promise<ApiResponse> {
		try {
			const contract = new StellarSDK.Contract(contractId)
			const account = await this.horizonServer.loadAccount(disputeResolver)

			const { trustlineDecimals } = await this.getEscrowByContractID(
				disputeResolver,
				contractId,
			)

			const adjustedApproverFunds = adjustPricesToMicroUSDC({
				price: approverFunds,
				decimals: trustlineDecimals,
			})
			const scValapproverFunds = StellarSDK.nativeToScVal(
				adjustedApproverFunds,
				{ type: 'i128' },
			)
			const adjustedServiceProviderFunds = adjustPricesToMicroUSDC(
				receiverFunds,
				trustlineDecimals,
			)
			const scValServiceProviderFunds = StellarSDK.nativeToScVal(
				adjustedServiceProviderFunds,
				{ type: 'i128' },
			)

			const operations = [
				contract.call(
					'resolving_disputes',
					StellarSDK.Address.fromString(disputeResolver).toScVal(),
					scValapproverFunds,
					scValServiceProviderFunds,
					StellarSDK.Address.fromString(this.trustlessAddress).toScVal(),
				),
			]

			const transaction = buildTransaction(account, operations)
			const preparedTransaction =
				await this.sorobanServer.prepareTransaction(transaction)

			const txHash = preparedTransaction.hash().toString('hex')

			this.pendingWriteQueue.add(txHash, {
				type: 'RESOLVE_DISPUTE',
				payload: {
					contractId,
					disputeResolver,
					approverFunds,
					receiverFunds,
				},
			})

			return {
				status: StellarSDK.rpc.Api.GetTransactionStatus.SUCCESS,
				unsignedTransaction: preparedTransaction.toXDR(),
			}
		} catch (error) {
			if (error.message.includes('HostError: Error(Contract, #')) {
				const errorCode = error.message.match(/Error\(Contract, #(\d+)\)/)?.[1]
				const errorMessage = mapErrorCodeToMessage(errorCode)
				throw new HttpException(
					{ status: HttpStatus.BAD_REQUEST, message: errorMessage },
					HttpStatus.BAD_REQUEST,
				)
			}

			throw error
		}
	}

	async changeMilestonesStatus(
		contractId: string,
		milestone_index: string,
		new_status: string,
		new_evidence: string,
		service_provider: string,
	): Promise<ApiResponse> {
		try {
			const contract = new StellarSDK.Contract(contractId)
			const account = await this.horizonServer.loadAccount(service_provider)

			const operations = [
				contract.call(
					'change_milestone_status',
					StellarSDK.nativeToScVal(milestone_index, { type: 'i128' }),
					StellarSDK.xdr.ScVal.scvString(new_status),
					new_evidence
						? StellarSDK.xdr.ScVal.scvString(new_evidence)
						: StellarSDK.xdr.ScVal.scvString(''),
					StellarSDK.Address.fromString(service_provider).toScVal(),
				),
			]

			const transaction = buildTransaction(account, operations)
			const preparedTransaction =
				await this.sorobanServer.prepareTransaction(transaction)

			const txHash = preparedTransaction.hash().toString('hex')

			this.pendingWriteQueue.add(txHash, {
				type: 'UPDATE_MILESTONE_STATUS',
				payload: { contractId, milestone_index, new_status, new_evidence },
			})

			return {
				status: StellarSDK.rpc.Api.GetTransactionStatus.SUCCESS,
				unsignedTransaction: preparedTransaction.toXDR(),
			}
		} catch (error) {
			if (error.message.includes('HostError: Error(Contract, #')) {
				const errorCode = error.message.match(/Error\(Contract, #(\d+)\)/)?.[1]
				const errorMessage = mapErrorCodeToMessage(errorCode)
				throw new HttpException(
					{ status: HttpStatus.BAD_REQUEST, message: errorMessage },
					HttpStatus.BAD_REQUEST,
				)
			}

			throw error
		}
	}

	async changeMilestonesFlag(
		contractId: string,
		milestone_index: string,
		new_flag: boolean,
		approver: string,
	): Promise<ApiResponse> {
		try {
			const contract = new StellarSDK.Contract(contractId)
			const account = await this.horizonServer.loadAccount(approver)

			const scValMilestoneIndex = StellarSDK.nativeToScVal(milestone_index, {
				type: 'i128',
			})

			const operations = [
				contract.call(
					'change_milestone_flag',
					scValMilestoneIndex,
					StellarSDK.nativeToScVal(new_flag, { type: 'bool' }),
					StellarSDK.Address.fromString(approver).toScVal(),
				),
			]

			const transaction = buildTransaction(account, operations)
			const preparedTransaction =
				await this.sorobanServer.prepareTransaction(transaction)

			const txHash = preparedTransaction.hash().toString('hex')

			this.pendingWriteQueue.add(txHash, {
				type: 'UPDATE_MILESTONE_FLAG',
				payload: { contractId, milestone_index, new_flag },
			})

			return {
				status: StellarSDK.rpc.Api.GetTransactionStatus.SUCCESS,
				unsignedTransaction: preparedTransaction.toXDR(),
			}
		} catch (error) {
			if (error.message.includes('HostError: Error(Contract, #')) {
				const errorCode = error.message.match(/Error\(Contract, #(\d+)\)/)?.[1]
				const errorMessage = mapErrorCodeToMessage(errorCode)
				throw new HttpException(
					{ status: HttpStatus.BAD_REQUEST, message: errorMessage },
					HttpStatus.BAD_REQUEST,
				)
			}

			throw error
		}
	}

	async changeDisputeFlag(
		contractId: string,
		signer: string,
	): Promise<ApiResponse> {
		try {
			const contract = new StellarSDK.Contract(contractId)
			const account = await this.sorobanServer.getAccount(signer)

			const operations = [contract.call('change_dispute_flag')]

			const transaction = buildTransaction(account, operations)
			const preparedTransaction =
				await this.sorobanServer.prepareTransaction(transaction)

			const txHash = preparedTransaction.hash().toString('hex')

			this.pendingWriteQueue.add(txHash, {
				type: 'START_DISPUTE',
				payload: { contractId },
			})

			return {
				status: StellarSDK.rpc.Api.GetTransactionStatus.SUCCESS,
				unsignedTransaction: preparedTransaction.toXDR(),
			}
		} catch (error) {
			if (error.message.includes('HostError: Error(Contract, #')) {
				const errorCode = error.message.match(/Error\(Contract, #(\d+)\)/)?.[1]
				const errorMessage = mapErrorCodeToMessage(errorCode)
				throw new HttpException(
					{ status: HttpStatus.BAD_REQUEST, message: errorMessage },
					HttpStatus.BAD_REQUEST,
				)
			}

			throw error
		}
	}

	async updateEscrowByContractID(
		contractId: string,
		signer: string,
		escrow: EscrowDto,
	): Promise<ApiResponse> {
		try {
			const platformSignerPubkey = new PublicKey(signer)
			const escrowAccountPubkey = SolanaAcc(contractId)

			// Parse the DTO into the data structure expected by the Solana program
			// Ensure EscrowDto has all necessary fields as per EscrowStructure/SolanaEscrowData
			const solanaEscrowData = parseEscrowDtoToSolanaEscrowData(escrow as any) // Cast as any if EscrowDto type is too generic

			const instruction = await this.program.methods
				.changeEscrowProperties(solanaEscrowData)
				.accounts({
					platform: platformSignerPubkey,
					escrowAccount: escrowAccountPubkey,
					systemProgram: SystemProgram.programId,
				})
				.instruction()

			const transaction = new Transaction().add(instruction)
			transaction.feePayer = platformSignerPubkey
			const { blockhash } =
				await this.solanaServer.getLatestBlockhash('confirmed')
			transaction.recentBlockhash = blockhash

			// Serialize the transaction to be signed on the client-side
			const serializedTx = transaction.serialize({
				requireAllSignatures: false, // unsigned transaction
				verifySignatures: false,
			})
			const unsignedTransaction = serializedTx.toString('base64')

			// Update Firestore (this part can remain similar)
			await this.escrowFirestoreService.updateEscrowData(
				contractId,
				signer,
				escrow, // The original DTO
			)

			// Add to pending write queue
			// Create a hash for the queue key if needed, e.g., from the serialized transaction
			const txHashForQueue = crypto
				.createHash('sha256')
				.update(serializedTx)
				.digest('hex')

			this.pendingWriteQueue.add(txHashForQueue, {
				type: 'EDIT_ESCROW',
				payload: { contractId, signer, escrow },
			})

			return {
				// For Solana, status might not map directly to Stellar's GetTransactionStatus
				// Consider a more generic success indicator or just the unsigned tx
				status: 'success' as any, // Or a relevant status for pre-flight success
				unsignedTransaction: unsignedTransaction,
			}
		} catch (error) {
			console.error('Error in updateEscrowByContractID (Solana):', error)
			// Handle Solana/Anchor specific errors if possible
			// For example, Anchor might throw errors with `error.logs`
			let message = 'Failed to prepare Solana transaction to update escrow.'
			if (error instanceof Error) {
				message = error.message
			}
			// Check for Anchor error logs if available
			if (error.logs) {
				console.error('Anchor logs:', error.logs)
				// You could try to parse a more specific error message from logs
			}
			throw new HttpException(
				{ status: HttpStatus.BAD_REQUEST, message },
				HttpStatus.BAD_REQUEST,
			)
		}
	}

	async getEscrowByContractID(
		signer,
		contractId: string,
	): Promise<EscrowCamelCaseResponse> {
		try {
			const contract = new StellarSDK.Contract(this.trustlessContractId)
			const account = await this.horizonServer.loadAccount(signer)

			const operations = [
				contract.call(
					'get_escrow_by_contract_id',
					StellarSDK.Address.fromString(contractId).toScVal(),
				),
			]

			const transaction = buildTransaction(account, operations)
			const preparedTransaction =
				await this.sorobanServer.prepareTransaction(transaction)
			const result = (await this.sorobanServer.simulateTransaction(
				preparedTransaction,
			)) as unknown as {
				result: Record<string, unknown>
			}

			const retval = result.result?.retval
			if (!retval) {
				throw new Error('No se pudo obtener el valor de retorno del contrato.')
			}

			const parseEscrow = parseEscrowByContractId(retval)

			return parseEscrow
		} catch (error) {
			if (error.message.includes('HostError: Error(Contract, #')) {
				const errorCode = error.message.match(/Error\(Contract, #(\d+)\)/)?.[1]
				const errorMessage = mapErrorCodeToMessage(errorCode)
				throw new HttpException(
					{ status: HttpStatus.BAD_REQUEST, message: errorMessage },
					HttpStatus.BAD_REQUEST,
				)
			}

			throw error
		}
	}
}
