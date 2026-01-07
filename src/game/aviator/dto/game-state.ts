export enum AviatorGamePhase {
    BETTING = 'BETTING',     
    FLYING = 'FLYING',      
    CRASHED = 'CRASHED',    
    PAUSED = 'PAUSED'        
}

export interface AviatorGlobalState {
    phase: AviatorGamePhase;
    roundId: string;
    serverTime: number;
    endTime?: number;       
    currentMultiplier: number;
    selectedStock: string;
    currentPrice: number;    
    lastPrice: number;       
    delta: number;           
    crashReason?: 'MARKET_DROP' | 'MAX_WIN' | 'FORCE';
}

export interface AviatorBetPayload {
    amount: number;
    side: 'LEFT' | 'RIGHT';
    autoCashOut?: number;
}