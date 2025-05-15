import { Module } from '@nestjs/common'
import { AnchorService } from './anchor/anchor.service'
import { DeployerModule } from './deployer/deployer.module'
import { EscrowModule } from './escrow/escrow.module'
// import { UserModule } from "./user/user.module";
import { HelperModule } from './helper/helper.module'

@Module({
	imports: [EscrowModule /*, UserModule*/, HelperModule, DeployerModule],
	providers: [AnchorService],
	exports: [AnchorService],
})
export class SolanaContractModule {}
