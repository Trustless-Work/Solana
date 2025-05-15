# Refactoring Guide: Solana Contract Integration with Anchor

This guide demonstrates how to refactor your existing Solana contract integration to use the Anchor framework, making your code more type-safe and maintainable.

## 1. Adding Required Dependencies

First, ensure you have all the necessary dependencies in your project:

```bash
npm install @coral-xyz/anchor @project-serum/anchor
```

## 2. Utility Files Created/Modified

The following files were created or modified to support the Anchor integration:

- `apps/server/src/utils/transaction-anchor.utils.ts` - Core Anchor transaction utilities
- `apps/server/src/utils/parse-anchor.utils.ts` - Parse and convert data for Anchor
- `apps/server/src/solana-contract/anchor/anchor.service.ts` - Service for Anchor program interactions
- `apps/server/src/solana-contract/escrow/escrow-anchor.service.ts` - Anchor-powered escrow service

## 3. Implementation Examples

### Example 1: Fund Escrow

**Before** (using raw Web3.js):

```typescript
async fundEscrow(contractId: string, signer: string, amount: string): Promise<ApiResponse> {
  const escrowAccount = new PublicKey(contractId);
  const signPublicKey = new PublicKey(signer);
  const programId = new PublicKey(apiConfig.solanaProgramId);

  const payloadBuffer = Buffer.alloc(9);
  payloadBuffer.writeUInt8(0, 0); // instruction type

  // Convert amount to BigInt and write as 64-bit integer
  const amountBigInt = BigInt(amount);
  for (let i = 0; i < 8; i++) {
    payloadBuffer.writeUInt8(
      Number((amountBigInt >> BigInt(i * 8)) & BigInt(0xff)),
      i + 1,
    );
  }

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: escrowAccount, isSigner: false, isWritable: true },
      { pubkey: signPublicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data: payloadBuffer,
  });

  const transaction = new Transaction().add(instruction);
  // ... rest of the code
}
```

**After** (using Anchor):

```typescript
async fundEscrow(contractId: string, signer: string, amount: string): Promise<ApiResponse> {
  // Convert addresses to PublicKeys
  const escrowAccount = new PublicKey(contractId);
  const signerPublicKey = new PublicKey(signer);

  // Get the Anchor program instance
  const program = this.anchorService.getEscrowProgram();

  // Convert amount string to BN for Anchor
  const amountBN = toBN(amount);

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
  });

  // Add to the pending write queue
  this.pendingWriteQueue.add(txId, {
    type: 'FUND_ESCROW',
    payload: { contractId, amount },
  });

  // Return the transaction for signing
  return {
    status: 'success',
    unsignedTransaction: serializedTransaction,
  };
}
```

### Example 2: Change Dispute Flag

**Before** (using raw Web3.js or Stellar SDK):

```typescript
async changeDisputeFlag(contractId: string, signer: string): Promise<ApiResponse> {
  const contract = new StellarSDK.Contract(contractId);
  const account = await this.sorobanServer.getAccount(signer);

  const operations = [contract.call('change_dispute_flag')];

  const transaction = buildTransaction(account, operations);
  const preparedTransaction = await this.sorobanServer.prepareTransaction(transaction);

  // ... rest of the code
}
```

**After** (using Anchor):

```typescript
async changeDisputeFlag(contractId: string, signer: string): Promise<ApiResponse> {
  // Convert addresses to PublicKeys
  const escrowAccount = new PublicKey(contractId);
  const signerPublicKey = new PublicKey(signer);

  // Get the Anchor program instance
  const program = this.anchorService.getEscrowProgram();

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
  });

  // Add to the pending write queue
  this.pendingWriteQueue.add(txId, {
    type: 'START_DISPUTE',
    payload: { contractId },
  });

  // Return the transaction for signing
  return {
    status: 'success',
    unsignedTransaction: serializedTransaction,
  };
}
```

### Example 3: Fetching Account Data

**Before** (using raw account deserialization):

```typescript
async getEscrowByContractID(signer, contractId: string): Promise<EscrowCamelCaseResponse> {
  const contract = new StellarSDK.Contract(this.trustlessContractId);
  const account = await this.horizonServer.loadAccount(signer);

  const operations = [
    contract.call(
      'get_escrow_by_contract_id',
      StellarSDK.Address.fromString(contractId).toScVal(),
    ),
  ];

  const transaction = buildTransaction(account, operations);
  const preparedTransaction = await this.sorobanServer.prepareTransaction(transaction);
  const result = await this.sorobanServer.simulateTransaction(preparedTransaction);

  const retval = result.result?.retval;
  if (!retval) {
    throw new Error('Could not get return value from contract.');
  }

  return parseEscrowByContractId(retval);
}
```

**After** (using Anchor):

```typescript
async getEscrowByContractID(signer: string, contractId: string): Promise<EscrowCamelCaseResponse> {
  // Convert address to PublicKey
  const escrowAccountPubkey = new PublicKey(contractId);

  // Get the Anchor program
  const program = this.anchorService.getEscrowProgram();

  // Fetch the account data using Anchor's typed fetching
  const escrowAccount = await program.account.escrowAccount.fetch(escrowAccountPubkey);

  // Convert Anchor account data to your API response format
  return {
    approver: escrowAccount.approver.toString(),
    receiver: escrowAccount.receiver.toString(),
    amount: fromBN(escrowAccount.amount),
    title: escrowAccount.title || '',
    description: escrowAccount.description || '',
    status: escrowAccount.status || 'PENDING',
    disputeFlag: escrowAccount.disputeFlag || false,
    trustlineDecimals: 6, // Default for USDC
    // Map other fields as needed
  };
}
```

## 4. Key Utility Functions

### Building Transactions

```typescript
// From transaction-anchor.utils.ts
export async function buildAnchorTransaction({
  program,
  methodName,
  args = [],
  accounts,
  feePayer,
}: {
  program: Program;
  methodName: string;
  args?: any[];
  accounts: Record<string, PublicKey>;
  feePayer: PublicKey;
}): Promise<{
  transaction: Transaction;
  serializedTransaction: string;
  txId: string;
}> {
  // Build transaction using Anchor's fluent interface
  const tx = await program.methods[methodName](...args)
    .accounts(accounts)
    .transaction();

  // Set fee payer
  tx.feePayer = feePayer;

  // Get recent blockhash
  const { blockhash } =
    await program.provider.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  // Serialize for client-side signing
  const serializedTx = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  // Create transaction ID hash for tracking
  const txId = createHash("sha256").update(serializedTx).digest("hex");

  return {
    transaction: tx,
    serializedTransaction: serializedTx.toString("base64"),
    txId,
  };
}
```

### Converting Data Types

```typescript
// From parse-anchor.utils.ts
export function toBN(amount: string | number): anchor.BN {
  try {
    return new anchor.BN(amount);
  } catch (error) {
    console.error("Error converting to BN:", error);
    return new anchor.BN(0);
  }
}

export function fromBN(bn: anchor.BN | null | undefined): string {
  if (!bn) return "0";
  return bn.toString();
}

export function toMicroUSDC(
  amount: string | number,
  decimals: number = 6,
): anchor.BN {
  const amountStr = amount.toString();
  const [integerPart, fractionalPart = ""] = amountStr.split(".");

  let paddedFractional = fractionalPart
    .padEnd(decimals, "0")
    .slice(0, decimals);
  const microAmount = integerPart + paddedFractional;

  return new anchor.BN(microAmount);
}
```

## 5. Next Steps

1. Use the examples above to refactor all remaining methods in your escrow service
2. Update the controller to inject the EscrowAnchorService where needed
3. Consider a phased approach where you migrate one method at a time
4. Add proper error handling for Anchor program errors
5. Write tests to verify the refactored methods work as expected

This refactoring makes your code more robust through compile-time type checking, automatic account deserialization, and simpler transaction building.
