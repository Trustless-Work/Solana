import * as anchor from '@coral-xyz/anchor'
import { type Escrow, EscrowIDL } from '@programs/solana-tl'
import { Keypair } from '@solana/web3.js'
import { assert } from 'chai'

describe('test_initialize_escrow', () => {
	anchor.setProvider(anchor.AnchorProvider.env())
	const program = anchor.workspace.Escrow as anchor.Program<Escrow>

	it('should initialize an escrow successfully', async () => {
		// Generate dummy keypairs
		const admin = Keypair.generate()
		const approver = Keypair.generate()
		const platform = Keypair.generate()
		const serviceProvider = Keypair.generate()
		const releaseSigner = Keypair.generate()
		const disputeResolver = Keypair.generate()

		const engagementId = `eng-${Date.now()}`
		const amount = new anchor.BN(100_000_000)
		const platformFee = new anchor.BN(3)
		const receiverMemo = new anchor.BN(0)

		// Build milestones
		const milestones = [
			{
				description: 'First milestone',
				status: 'Pending',
				evidence: 'Initial evidence',
				approvedFlag: false,
			},
			{
				description: 'Second milestone',
				status: 'Pending',
				evidence: 'Initial evidence',
				approvedFlag: false,
			},
		]

		// Dummy USDC token address (replace with real one if needed)
		const usdcMint = Keypair.generate()

		// Moved inside the test block to ensure freshness
		// const escrowAccount = Keypair.generate();
		const [escrowAccount] = anchor.web3.PublicKey.findProgramAddressSync(
			[Buffer.from('escrow'), Buffer.from(engagementId)],
			program.programId,
		)

		await program.methods
			.initializeEscrow({
				engagementId,
				title: 'Test Escrow',
				description: 'Test Escrow Description',
				amount,
				platformFee,
				milestones,
				flags: {
					dispute: false,
					release: false,
					resolved: false,
				},
				trustline: {
					address: usdcMint.publicKey,
					decimals: new anchor.BN(10_000_000),
				},
				receiverMemo,
				roles: {
					approver: approver.publicKey,
					serviceProvider: serviceProvider.publicKey,
					platformAddress: platform.publicKey,
					releaseSigner: releaseSigner.publicKey,
					disputeResolver: disputeResolver.publicKey,
					receiver: serviceProvider.publicKey,
				},
			})
			.accounts({
				escrowAccount,
				initializer: program.provider.publicKey,
			})
			.rpc()
		// .signers([escrowAccount])

		const fetched = await program.account.escrowData.fetch(escrowAccount)

		assert.equal(fetched.engagementId, engagementId)
		assert.equal(fetched.amount.toNumber(), amount.toNumber())
		assert.equal(fetched.platformFee, platformFee)
		assert.deepEqual(
			fetched.roles.approver.toBase58(),
			approver.publicKey.toBase58(),
		)
		assert.deepEqual(
			fetched.roles.serviceProvider.toBase58(),
			serviceProvider.publicKey.toBase58(),
		)
		assert.deepEqual(
			fetched.roles.platformAddress.toBase58(),
			platform.publicKey.toBase58(),
		)
		assert.deepEqual(
			fetched.roles.releaseSigner.toBase58(),
			releaseSigner.publicKey.toBase58(),
		)
		assert.deepEqual(
			fetched.roles.disputeResolver.toBase58(),
			disputeResolver.publicKey.toBase58(),
		)
		assert.deepEqual(
			fetched.roles.receiver.toBase58(),
			serviceProvider.publicKey.toBase58(),
		)
		assert.equal(fetched.receiverMemo.toNumber(), receiverMemo.toNumber())
		assert.equal(fetched.milestones.length, 2)
	})
})
