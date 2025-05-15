import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { AuthModule } from './auth/auth.module'
import { FirebaseModule } from './firebase/firebase.module'
import { NotificationsModule } from './notifications/notifications.module'
import { SolanaContractModule } from './solana-contract/solana-contract.module'

@Module({
	imports: [
		SolanaContractModule,
		ThrottlerModule.forRoot([
			{
				ttl: 60000,
				limit: 50,
			},
		]),
		AuthModule,
		FirebaseModule,
		NotificationsModule,
	],
	controllers: [],
	providers: [
		{
			provide: APP_GUARD,
			useClass: ThrottlerGuard,
		},
	],
})
export class AppModule {}
