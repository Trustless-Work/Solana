import * as anchor from '@coral-xyz/anchor'
import { Program } from '@coral-xyz/anchor'
import { HttpException, HttpStatus } from '@nestjs/common'
import { PublicKey } from '@solana/web3.js'

/**
 * Parse and deserialize an account using Anchor
 * @param program Anchor program instance
 * @param accountAddress Account address to fetch and parse
 * @param accountType Type of account to fetch (from IDL)
 * @returns Parsed account data
 */
export async function parseAnchorAccount<T>(
	program: Program,
	accountAddress: PublicKey,
	accountType: string,
): Promise<T> {
	try {
		if (!program.account[accountType]) {
			throw new Error(`Account type "${accountType}" not found in program`)
		}

		return (await program.account[accountType].fetch(accountAddress)) as T
	} catch (error) {
		console.error(`Error parsing ${accountType} account:`, error)

		let errorMessage = `Failed to parse ${accountType} account`
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
 * Convert an EscrowDto to an Anchor-compatible escrow data structure
 * The structure should match the Rust struct in your Solana program
 */
export function escrowDtoToAnchorData(dto: any): any {
	// This should be customized based on your specific contract's expected format
	return {
		title: dto.title || '',
		description: dto.description || '',
		status: dto.status || 'PENDING',
		amount: new anchor.BN(dto.amount || 0),
		approver: dto.approver ? new PublicKey(dto.approver) : undefined,
		receiver: dto.receiver ? new PublicKey(dto.receiver) : undefined,
		// Add other fields as needed
	}
}

/**
 * Convert Anchor escrow data to API response format
 */
export function anchorEscrowToResponse(anchorData: any): any {
	return {
		title: anchorData.title,
		description: anchorData.description,
		status: anchorData.status,
		amount: anchorData.amount ? anchorData.amount.toString() : '0',
		approver: anchorData.approver ? anchorData.approver.toString() : '',
		receiver: anchorData.receiver ? anchorData.receiver.toString() : '',
		// Add other fields as needed
		trustlineDecimals: 6, // Default for USDC
	}
}

/**
 * Extract a program method signature from IDL
 * Helps ensure proper args are passed to Anchor methods
 */
export function getProgramMethodSignature(
	program: Program,
	methodName: string,
): string[] {
	const idl = program.idl
	const instruction = idl.instructions.find(
		(instr) => instr.name === methodName,
	)

	if (!instruction) {
		throw new Error(`Method "${methodName}" not found in program IDL`)
	}

	return instruction.args.map((arg) => arg.name)
}

/**
 * Convert any Amount to Micro USDC
 * @param amount Amount to convert
 * @param decimals Decimals to use for conversion (default is 6 for USDC)
 */
export function toMicroUSDC(amount: string | number, decimals = 6): anchor.BN {
	const amountStr = amount.toString()
	const [integerPart, fractionalPart = ''] = amountStr.split('.')

	const paddedFractional = fractionalPart
		.padEnd(decimals, '0')
		.slice(0, decimals)
	const microAmount = integerPart + paddedFractional

	return new anchor.BN(microAmount)
}

/**
 * Convert Micro USDC to normal amount
 * @param microAmount Micro amount to convert
 * @param decimals Decimals to use for conversion (default is 6 for USDC)
 */
export function fromMicroUSDC(microAmount: anchor.BN, decimals = 6): string {
	if (!microAmount) return '0'

	const amountStr = microAmount.toString().padStart(decimals + 1, '0')
	const integerPart = amountStr.slice(0, -decimals) || '0'
	const fractionalPart = amountStr.slice(-decimals)

	// Remove trailing zeros
	const trimmedFractional = fractionalPart.replace(/0+$/, '')

	if (trimmedFractional) {
		return `${integerPart}.${trimmedFractional}`
	}

	return integerPart
}
