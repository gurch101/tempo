export type Bindings = Cloudflare.Env & {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  D1_ADMIN_DEV?: string;
  GOOGLE_HEALTH_CLIENT_ID?: string;
  GOOGLE_HEALTH_CLIENT_SECRET?: string;
  GOOGLE_HEALTH_TOKEN_KEY?: string;
};

export interface TempoState {
  schemaVersion: number;
  timers: Array<Record<string, unknown>>;
  widgets: Array<Record<string, unknown>>;
  logs: Record<string, Record<string, Record<string, unknown>>>;
  foods: Array<Record<string, unknown>>;
  meals: Array<Record<string, unknown>>;
  foodLogs: Record<string, Array<Record<string, unknown>>>;
  nutritionGoal: Record<string, number> | null;
  recentFoodIds: string[];
  recentMealIds: string[];
  strength: {
    unit: string;
    workouts: Array<Record<string, unknown>>;
    mesocycles: Array<Record<string, unknown>>;
    activeMesocycleId: string;
  };
  legacyDefaultsRemoved: boolean;
}

export interface SpaceRow {
  id: number;
  access_key_hash: string;
  revision: number;
  write_token: string;
  write_token_at: number | null;
  timezone: string;
  strength_unit: string;
  active_mesocycle_id: number | null;
  nutrition_calories: number | null;
  nutrition_carbs: number | null;
  nutrition_protein: number | null;
  nutrition_fats: number | null;
  nutrition_fibre: number | null;
  finance_display_currency: string;
  walkthrough_status: "pending" | "completed" | "dismissed";
}
