export interface LiveStepsPaceInput {
  goal: number | null;
  todaySteps: number;
  walkingMinutes?: number | null;
  sessions?: Array<{ date: string; endTime: number; nap: boolean }>;
  today: string;
  now?: number;
}

export interface LiveStepsPaceResult {
  wakeTime: number;
  remainingSteps: number;
  remainingMinutes: number;
  hourlySteps: number | null;
}

export function liveStepsPace(input: LiveStepsPaceInput): LiveStepsPaceResult | null;
