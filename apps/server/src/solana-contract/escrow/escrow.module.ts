import { Module } from '@nestjs/common'
import { AuthModule } from 'src/auth/auth.module'
import { FirebaseModule } from 'src/firebase/firebase.module'
import { AnchorService } from '../anchor/anchor.service'
import { HelperModule } from '../helper/helper.module'
import { QueueModule } from '../queue/queue.module'
import { EscrowAnchorService } from './escrow-anchor.service'
import { EscrowController } from './escrow.controller'
import { EscrowService } from './escrow.service'
import { EscrowFirestoreService } from './firestore-services/escrow-firestore.service'

@Module({
	imports: [AuthModule, FirebaseModule, QueueModule, HelperModule],
	controllers: [EscrowController],
	providers: [
		EscrowService,
		EscrowAnchorService,
		EscrowFirestoreService,
		AnchorService,
	],
	exports: [EscrowFirestoreService, EscrowAnchorService, AnchorService],
})
export class EscrowModule {}
