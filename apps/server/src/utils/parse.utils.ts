import * as anchor from '@coral-xyz/anchor'
import { Program } from '@coral-xyz/anchor'
import * as borsh from '@project-serum/borsh'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { Structure } from 'buffer-layout.types'
import { ESCROW_ACCOUNT_STATE_SCHEMA } from 'src/config/constants/escrow-borsh-struct.constant'
import {
	Escrow,
	EscrowStructure,
	EscrowSwapData,
	SmartContractEscrowStructure,
} from 'src/interfaces/escrow.interface'
import { EscrowCamelCaseResponse } from 'src/interfaces/response.interface'
import type { EscrowDto } from '../solana-contract/escrow/Dto/escrow.dto'
import { bnToString } from './anchor.utils'

// Define the Borsh schema for the Milestone struct
const milestoneSchema = borsh.struct([
	borsh.bool('approved_flag'),
	borsh.str('description'),
	borsh.str('evidence'),
	borsh.str('status'), // Assuming status is stored as a string on-chain
])

// Define the Borsh schema for the SwapData struct
const swapDataSchema = borsh.struct([
	borsh.u128('originalAmount'),
	borsh.str('originalCurrency'),
	borsh.u128('tokenAmount'),
	borsh.str('tokenCurrency'),
	borsh.str('conversionTxHash'),
	borsh.u128('conversionRate'),
	borsh.u64('conversionTimestamp'), // Assuming conversionTimestamp is a u64
])

// Define the Borsh schema for the Escrow struct
// NOTE: Adjust field types (e.g., u64, u128) based on the actual Rust struct definition. For now assuming some initial values
// TODO: Improve structure generic to accept a created interface to return such data type when encrypting/decrypting
const escrowSchema: Structure<EscrowStructure> = borsh.struct([
	borsh.str('engagementId'),
	borsh.str('title'),
	borsh.str('description'),
	borsh.str('amount'),
	borsh.publicKey('approver'),
	borsh.publicKey('serviceProvider'),
	borsh.publicKey('platformAddress'),
	borsh.i128('platformFee'), // Use u128 or u64 as appropriate
	borsh.publicKey('releaseSigner'),
	borsh.publicKey('disputeResolver'),
	borsh.publicKey('trustline'), // Assuming this is the token mint address
	borsh.publicKey('receiver'),
	borsh.i128('trustlineDecimals'),
	borsh.u64('receiverMemo'), // Use u64 or another appropriate type
	borsh.bool('disputeFlag'),
	borsh.bool('releaseFlag'),
	borsh.bool('resolvedFlag'),
	borsh.str('contractId'),
	borsh.vec(milestoneSchema, 'milestones'),
	borsh.vec(swapDataSchema, 'swapData'),
])

/**
 * Serializes Escrow data using the Borsh schema.
 * @param escrow - The Escrow data transfer object.
 * @returns A buffer containing the serialized data.
 */
export function serializeEscrow(escrow: EscrowDto): Buffer {
	const { amount: price, trustlineDecimals: decimals } = escrow

	const value: EscrowStructure = {
		...escrow,
		amount: adjustPricesToMicroUSDC({ price, decimals }),
		approver: new PublicKey(escrow.approver),
		serviceProvider: new PublicKey(escrow.serviceProvider),
		platformAddress: new PublicKey(escrow.platformAddress),
		platformFee: new BN(escrow.platformFee), // Assuming platformFee is u128 or similar requiring BN
		releaseSigner: new PublicKey(escrow.releaseSigner),
		disputeResolver: new PublicKey(escrow.disputeResolver),
		trustline: new PublicKey(escrow.trustline),
		receiver: new PublicKey(escrow.receiver),
		receiverMemo: new BN(escrow.receiverMemo), // Assuming receiverMemo is u64 or similar
	}

	const buffer = Buffer.alloc(escrowSchema.getSpan(value))
	escrowSchema.encode(value, buffer)
	return buffer
}

/**
 * Deserializes Escrow data from a buffer using the Borsh schema.
 * @param buffer - The buffer containing the serialized Escrow data.
 * @returns The deserialized Escrow object.
 */
export function deserializeEscrow(buffer: Buffer) {
	const {
		title,
		description,
		engagement_id,
		receiver,
		approver,
		trustline,
		release_signer,
		service_provider,
		dispute_resolver,
		platform_address,
		amount,
		platform_fee,
		receiver_memo,
		trustline_decimals,
		dispute_flag,
		release_flag,
		resolved_flag,
		milestones,
		swap_data,
	} = ESCROW_ACCOUNT_STATE_SCHEMA.decode(buffer) as SmartContractEscrowStructure

	const escrow: EscrowCamelCaseResponse = {
		title,
		description,
		engagementId: engagement_id,
		receiver: receiver.toBase58(),
		approver: approver.toBase58(),
		trustline: trustline.toBase58(),
		releaseSigner: release_signer.toBase58(),
		serviceProvider: service_provider.toBase58(),
		disputeResolver: dispute_resolver.toBase58(),
		platformAddress: platform_address.toBase58(),
		amount: microUSDTToDecimal({
			microToken: BigInt(amount.toString()),
			decimals: trustline_decimals,
		}),
		platformFee: platform_fee,
		receiverMemo: receiver_memo,
		trustlineDecimals: trustline_decimals,
		disputeFlag: Boolean(dispute_flag),
		releaseFlag: Boolean(release_flag),
		resolvedFlag: Boolean(resolved_flag),
		milestones,
		swapData: swap_data
			? {
					originalAmount: swap_data.original_amount.toString(),
					originalCurrency: swap_data.original_currency,
					tokenAmount: swap_data.token_amount.toString(),
					tokenCurrency: swap_data.token_currency,
					conversionTxHash: swap_data.conversion_tx_hash,
					conversionRate: swap_data.conversion_rate.toString(),
					conversionTimestamp: Number(
						swap_data.conversion_timestamp.toString(),
					),
				}
			: undefined,
	}

	return escrow
}

/**
 * Interface for Anchor-compatible account data
 */
export interface AnchorEscrowAccount {
	engagementId?: string
	title?: string
	description?: string
	amount?: anchor.BN
	approver?: PublicKey
	serviceProvider?: PublicKey
	platformAddress?: PublicKey
	platformFee?: anchor.BN
	releaseSigner?: PublicKey
	disputeResolver?: PublicKey
	trustline?: PublicKey
	receiver?: PublicKey
	trustlineDecimals?: anchor.BN
	receiverMemo?: anchor.BN
	disputeFlag?: boolean
	releaseFlag?: boolean
	resolvedFlag?: boolean
	milestones?: Array<{
		approvedFlag?: boolean
		description?: string
		evidence?: string
		status?: string
	}>
	swapData?: {
		originalAmount?: anchor.BN
		originalCurrency?: string
		tokenAmount?: anchor.BN
		tokenCurrency?: string
		conversionTxHash?: string
		conversionRate?: anchor.BN
		conversionTimestamp?: anchor.BN
	}
}

/**
 * Convert Anchor account to standard response format
 * @param anchorAccount The account fetched with Anchor
 * @returns Standardized response object
 */
export function convertAnchorEscrowToResponse(
	anchorAccount: AnchorEscrowAccount,
): Escrow {
	// Create escrow object
	const escrow: Escrow = {
		engagementId: anchorAccount.engagementId || '',
		title: anchorAccount.title || '',
		description: anchorAccount.description || '',
		amount: Number(bnToString(anchorAccount.amount)),
		approver: anchorAccount.approver?.toString() || '',
		serviceProvider: anchorAccount.serviceProvider?.toString() || '',
		platformAddress: anchorAccount.platformAddress?.toString() || '',
		platformFee: Number(bnToString(anchorAccount.platformFee)),
		releaseSigner: anchorAccount.releaseSigner?.toString() || '',
		disputeResolver: anchorAccount.disputeResolver?.toString() || '',
		trustline: anchorAccount.trustline?.toString() || '',
		receiver: anchorAccount.receiver?.toString() || '',
		trustlineDecimals: Number(bnToString(anchorAccount.trustlineDecimals)),
		receiverMemo: Number(bnToString(anchorAccount.receiverMemo)),
		disputeFlag: !!anchorAccount.disputeFlag,
		releaseFlag: !!anchorAccount.releaseFlag,
		resolvedFlag: !!anchorAccount.resolvedFlag || false,
		milestones:
			anchorAccount.milestones?.map((milestone) => ({
				approved_flag: !!milestone.approvedFlag,
				description: milestone.description || '',
				evidence: milestone.evidence || '',
				status: milestone.status || '',
			})) || [],
	}

	// Add swap data if available
	if (anchorAccount.swapData) {
		escrow.swapData = {
			originalAmount: bnToString(anchorAccount.swapData.originalAmount),
			originalCurrency: anchorAccount.swapData.originalCurrency || '',
			tokenAmount: bnToString(anchorAccount.swapData.tokenAmount),
			tokenCurrency: anchorAccount.swapData.tokenCurrency || '',
			conversionTxHash: anchorAccount.swapData.conversionTxHash || '',
			conversionRate: bnToString(anchorAccount.swapData.conversionRate),
			conversionTimestamp: Number(
				bnToString(anchorAccount.swapData.conversionTimestamp),
			),
		}
	}

	return escrow
}

/**
 * Fetch and deserialize an escrow account using Anchor
 * @param program Anchor Program instance
 * @param accountAddress Public key of the escrow account
 * @returns Deserialized escrow account
 */
export async function fetchAnchorEscrowAccount(
	program: Program,
	accountAddress: PublicKey,
): Promise<Escrow> {
	try {
		// Fetch the account using Anchor's typed account fetcher
		const escrowAccount = (await program.account.escrowAccount.fetch(
			accountAddress,
		)) as AnchorEscrowAccount
		return convertAnchorEscrowToResponse(escrowAccount)
	} catch (error) {
		console.error('Error fetching escrow with Anchor:', error)
		// Fall back to manual deserialization
		throw error
	}
}

export function adjustPricesToMicroUSDC({
	price,
	decimals,
}: {
	price: string
	decimals: number
}) {
	const microStable = BigInt(
		Math.round(Number.parseFloat(price.toString()) * decimals),
	)
	return microStable.toString()
}

export function microUSDTToDecimal({
	microToken,
	decimals,
}: {
	microToken: bigint | number
	decimals: number
}) {
	return Number(microToken) / decimals
}
