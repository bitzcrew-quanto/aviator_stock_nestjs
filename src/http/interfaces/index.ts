export interface HqBetRequest {
    sessionToken: string;
    betAmount: number;
    currency: string;
    transactionId: string;
    playerId?: string;
    tenantId?: string;
}

export interface HqBetResponse {
    status: string;
    data: {
        status: 'SUCCESS' | 'FAILED';
        newBalance: number;
        message?: string;
    }
}

export interface HqCreditRequest {
    sessionToken: string;
    winAmount: number;
    currency: string;
    transactionId: string;
    playerId?: string;
    tenantId?: string;
    type?: 'win' | 'refund';
    metadata?: any;
}

export interface HqCreditResponse {
    status: string;
    data: {
        status: 'SUCCESS' | 'FAILED';
        newBalance: number;
        message?: string;
    }
}
