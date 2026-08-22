import type { SpaceRow, TempoState } from "./types";
import { habitLogKey, parseLogKey } from "./log-keys";
import { remapForeignStateIds, type EntityKind, type OwnedIds } from "./id-remap";

type Row = Record<string, unknown>;
const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const s = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const b = (value: unknown) => value === true || value === 1;
const dbId = (value: unknown): number | null => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const rows = (result: D1Result) => result.results as Row[];

export async function readTimers(db: D1Database, spaceId: number): Promise<TempoState["timers"]> {
  const result = await db.prepare("SELECT * FROM timers WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(spaceId).all();
  return rows(result).map(row => ({ id:n(row.id), name:s(row.name), duration:n(row.duration_seconds,1), remaining:n(row.remaining_seconds), color:s(row.color), running:b(row.running), lastTick:row.checkpoint_at == null ? null : n(row.checkpoint_at), pomodoro:b(row.pomodoro), restDuration:n(row.rest_duration_seconds,300), phase:s(row.phase)==="rest"?"rest":"work", countdownBeeps:b(row.countdown_beeps), trackCompletions:b(row.track_completions), dailyTarget:n(row.daily_target,1), completedToday:n(row.completed_today), completionDate:row.completion_date == null ? null : s(row.completion_date) }));
}

export async function readHabits(db: D1Database, spaceId: number): Promise<TempoState["widgets"]> {
  const [habitResult, dayResult] = await db.batch([
    db.prepare("SELECT * FROM habits WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(spaceId),
    db.prepare("SELECT habit_id,weekday FROM habit_schedule_days WHERE space_id=? ORDER BY habit_id,weekday").bind(spaceId)
  ]);
  const habitDays = new Map<number, number[]>();
  for (const row of rows(dayResult)) (habitDays.get(n(row.habit_id)) || habitDays.set(n(row.habit_id), []).get(n(row.habit_id))!).push(n(row.weekday));
  return rows(habitResult).map(row => ({ id:n(row.id), name:s(row.name), type:s(row.kind)==="toggle"?"toggle":"counter", goal:n(row.goal,1), color:s(row.color), days:habitDays.get(n(row.id)) || [0,1,2,3,4,5,6] }));
}

export async function readHabitLogs(db: D1Database, spaceId: number, from?: string, to?: string): Promise<TempoState["logs"]> {
  const range = from && to ? " AND log_date BETWEEN ? AND ?" : from ? " AND log_date>=?" : to ? " AND log_date<=?" : "";
  const result = await db.prepare(`SELECT * FROM habit_daily_logs WHERE space_id=?${range} ORDER BY log_date,habit_id`).bind(spaceId,...(from&&to?[from,to]:from?[from]:to?[to]:[])).all();
  const logs: TempoState["logs"] = {};
  for (const row of rows(result)) { const date=s(row.log_date), id=habitLogKey(n(row.habit_id)); logs[date] ||= {}; logs[date][id]={name:s(row.name_snapshot),color:s(row.color_snapshot),type:s(row.kind_snapshot),goal:n(row.goal_snapshot,1),value:n(row.value),done:b(row.done)}; }
  return logs;
}

export async function readFoods(db: D1Database, spaceId: number): Promise<TempoState["foods"]> {
  const result = await db.prepare("SELECT * FROM foods WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(spaceId).all();
  return rows(result).map(row=>({id:n(row.id),title:s(row.title),servingSize:n(row.serving_size,1),servingUnit:s(row.serving_unit,"g"),calories:n(row.calories),carbs:n(row.carbs),protein:n(row.protein),fats:n(row.fats),fibre:n(row.fibre)}));
}

export async function readMeals(db: D1Database, spaceId: number): Promise<TempoState["meals"]> {
  const [mealResult, itemResult] = await db.batch([
    db.prepare("SELECT * FROM meals WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(spaceId),
    db.prepare("SELECT * FROM meal_items WHERE space_id=? ORDER BY meal_id,sort_order").bind(spaceId)
  ]);
  const itemsByMeal = new Map<number,Row[]>();
  for (const row of rows(itemResult)) (itemsByMeal.get(n(row.meal_id)) || itemsByMeal.set(n(row.meal_id),[]).get(n(row.meal_id))!).push({foodId:n(row.food_id),servingSize:n(row.serving_size,1)});
  return rows(mealResult).map(row=>({id:n(row.id),title:s(row.title),items:itemsByMeal.get(n(row.id))||[]}));
}

function recentNutritionIds(recent: Row[]) {
  return {
    recentFoodIds: [...new Set(recent.filter(row=>row.meal_id==null).map(row=>row.food_id==null?0:n(row.food_id)).filter(Boolean))].slice(0,6).map(String),
    recentMealIds: [...new Set(recent.map(row=>row.meal_id==null?0:n(row.meal_id)).filter(Boolean))].slice(0,6).map(String)
  };
}

export async function readFoodLogs(db: D1Database, spaceId: number, from?: string, to?: string): Promise<Pick<TempoState,"foodLogs"|"recentFoodIds"|"recentMealIds">> {
  const range = from && to ? " AND log_date BETWEEN ? AND ?" : from ? " AND log_date>=?" : to ? " AND log_date<=?" : "";
  const bindings = from&&to?[from,to]:from?[from]:to?[to]:[];
  const [result,recentFoods,recentMeals] = await db.batch([
    db.prepare(`SELECT * FROM food_log_entries WHERE space_id=?${range} ORDER BY log_date,logged_at,id`).bind(spaceId,...bindings),
    db.prepare("SELECT food_id FROM food_log_entries WHERE space_id=? AND meal_id IS NULL AND food_id IS NOT NULL GROUP BY food_id ORDER BY MAX(logged_at) DESC LIMIT 6").bind(spaceId),
    db.prepare("SELECT meal_id FROM food_log_entries WHERE space_id=? AND meal_id IS NOT NULL GROUP BY meal_id ORDER BY MAX(logged_at) DESC LIMIT 6").bind(spaceId)
  ]);
  const foodLogs: TempoState["foodLogs"] = {};
  for (const row of rows(result)) { const date=s(row.log_date); foodLogs[date] ||= []; foodLogs[date].push({id:n(row.id),foodId:row.food_id==null?"":n(row.food_id),mealId:row.meal_id==null?"":n(row.meal_id),servingSize:n(row.serving_size,1),loggedAt:n(row.logged_at),mealTitle:s(row.meal_title_snapshot),snapshot:{title:s(row.title_snapshot),servingSize:n(row.serving_size_snapshot,1),servingUnit:s(row.serving_unit_snapshot,"g"),calories:n(row.calories_snapshot),carbs:n(row.carbs_snapshot),protein:n(row.protein_snapshot),fats:n(row.fats_snapshot),fibre:n(row.fibre_snapshot)}}); }
  return {foodLogs,recentFoodIds:rows(recentFoods).map(row=>String(n(row.food_id))),recentMealIds:rows(recentMeals).map(row=>String(n(row.meal_id)))};
}

export function readNutritionGoal(space: SpaceRow): TempoState["nutritionGoal"] {
  return space.nutrition_calories == null ? null : {calories:n(space.nutrition_calories),carbs:n(space.nutrition_carbs),protein:n(space.nutrition_protein),fats:n(space.nutrition_fats),fibre:n(space.nutrition_fibre)};
}

export async function readStrength(db: D1Database, space: SpaceRow): Promise<TempoState["strength"]> {
  const sid=space.id;
  const result=await db.batch([
    db.prepare("SELECT * FROM workouts WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(sid),
    db.prepare("SELECT * FROM workout_exercises WHERE space_id=? AND deleted_at IS NULL ORDER BY workout_id,sort_order,id").bind(sid),
    db.prepare("SELECT * FROM mesocycles WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(sid),
    db.prepare("SELECT * FROM mesocycle_workouts WHERE space_id=? ORDER BY mesocycle_id,sort_order").bind(sid),
    db.prepare("SELECT * FROM mesocycle_weeks WHERE space_id=? ORDER BY mesocycle_id,week_index").bind(sid),
    db.prepare("SELECT * FROM workout_sessions WHERE space_id=? ORDER BY mesocycle_id,sort_order,id").bind(sid),
    db.prepare("SELECT * FROM session_exercises WHERE space_id=? ORDER BY session_id,sort_order,id").bind(sid),
    db.prepare("SELECT * FROM session_exercise_allocations WHERE space_id=? ORDER BY session_exercise_id,sort_order").bind(sid),
    db.prepare("SELECT * FROM exercise_sets WHERE space_id=? ORDER BY session_exercise_id,sort_order,id").bind(sid)
  ]);
  const exercisesByWorkout = new Map<number,Row[]>();
  for (const row of rows(result[1])) (exercisesByWorkout.get(n(row.workout_id)) || exercisesByWorkout.set(n(row.workout_id),[]).get(n(row.workout_id))!).push({id:n(row.id),name:s(row.name),muscleGroup:s(row.muscle_group),sets:n(row.planned_sets,1),reps:n(row.planned_reps),load:n(row.planned_load)});
  const workouts = rows(result[0]).map(row=>({id:n(row.id),name:s(row.name),exercises:exercisesByWorkout.get(n(row.id))||[]}));
  const mesocycles = rows(result[2]).map(row=>({id:n(row.id),name:s(row.name),progressionRate:n(row.progression_rate,.025),archived:n(row.id)!==space.active_mesocycle_id,workoutIds:[] as number[],weeks:[] as Row[],sessions:[] as Row[]}));
  const mesoById = new Map(mesocycles.map(item=>[item.id,item]));
  for (const row of rows(result[3])) mesoById.get(n(row.mesocycle_id))?.workoutIds.push(n(row.workout_id));
  for (const row of rows(result[4])) mesoById.get(n(row.mesocycle_id))?.weeks.push({deload:b(row.deload),completed:b(row.completed)});
  const sessions = new Map<number,Row>();
  for (const row of rows(result[5])) { const session:Row={id:n(row.id),templateId:row.workout_id==null?"":n(row.workout_id),name:s(row.name_snapshot),weekIndex:n(row.week_index),date:s(row.session_date),createdAt:n(row.created_at),status:s(row.status),unit:s(row.unit,"lb"),exercises:[]}; sessions.set(n(row.id),session); mesoById.get(n(row.mesocycle_id))?.sessions.push(session); }
  const sessionExercises = new Map<number,Row>();
  for (const row of rows(result[6])) { const exercise:Row={id:n(row.id),exerciseId:row.source_exercise_id==null?"":n(row.source_exercise_id),name:s(row.name_snapshot),muscleGroup:s(row.muscle_group_snapshot),mode:s(row.mode,"external"),bodyweightFactor:n(row.bodyweight_factor,1),unit:"lb",allocations:[],sets:[]}; sessionExercises.set(n(row.id),exercise); (sessions.get(n(row.session_id))?.exercises as Row[]|undefined)?.push(exercise); }
  for (const row of rows(result[7])) { const name=s(row.name_snapshot,"Other"); (sessionExercises.get(n(row.session_exercise_id))?.allocations as Row[]|undefined)?.push({muscleId:name.trim().toLocaleLowerCase(),name,share:n(row.share)}); }
  for (const row of rows(result[8])) (sessionExercises.get(n(row.session_exercise_id))?.sets as Row[]|undefined)?.push({id:n(row.id),reps:n(row.reps),load:n(row.load),completed:b(row.completed)});
  return {unit:space.strength_unit||"lb",workouts,mesocycles,activeMesocycleId:space.active_mesocycle_id==null?"":String(space.active_mesocycle_id)};
}

export async function readState(db: D1Database, space: SpaceRow): Promise<TempoState> {
  const sid = space.id;
  const result = await db.batch([
    db.prepare("SELECT * FROM timers WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(sid),
    db.prepare("SELECT * FROM habits WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(sid),
    db.prepare("SELECT habit_id,weekday FROM habit_schedule_days WHERE space_id=? ORDER BY habit_id,weekday").bind(sid),
    db.prepare("SELECT * FROM habit_daily_logs WHERE space_id=? ORDER BY log_date,habit_id").bind(sid),
    db.prepare("SELECT * FROM foods WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(sid),
    db.prepare("SELECT * FROM meals WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(sid),
    db.prepare("SELECT * FROM meal_items WHERE space_id=? ORDER BY meal_id,sort_order").bind(sid),
    db.prepare("SELECT * FROM food_log_entries WHERE space_id=? ORDER BY log_date,logged_at,id").bind(sid),
    db.prepare("SELECT * FROM workouts WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(sid),
    db.prepare("SELECT * FROM workout_exercises WHERE space_id=? AND deleted_at IS NULL ORDER BY workout_id,sort_order,id").bind(sid),
    db.prepare("SELECT * FROM mesocycles WHERE space_id=? AND deleted_at IS NULL ORDER BY sort_order,id").bind(sid),
    db.prepare("SELECT * FROM mesocycle_workouts WHERE space_id=? ORDER BY mesocycle_id,sort_order").bind(sid),
    db.prepare("SELECT * FROM mesocycle_weeks WHERE space_id=? ORDER BY mesocycle_id,week_index").bind(sid),
    db.prepare("SELECT * FROM workout_sessions WHERE space_id=? ORDER BY mesocycle_id,sort_order,id").bind(sid),
    db.prepare("SELECT * FROM session_exercises WHERE space_id=? ORDER BY session_id,sort_order,id").bind(sid),
    db.prepare("SELECT * FROM session_exercise_allocations WHERE space_id=? ORDER BY session_exercise_id,sort_order").bind(sid),
    db.prepare("SELECT * FROM exercise_sets WHERE space_id=? ORDER BY session_exercise_id,sort_order,id").bind(sid)
  ]);

  const timers = rows(result[0]).map(row => ({ id:n(row.id), name:s(row.name), duration:n(row.duration_seconds,1), remaining:n(row.remaining_seconds), color:s(row.color), running:b(row.running), lastTick:row.checkpoint_at == null ? null : n(row.checkpoint_at), pomodoro:b(row.pomodoro), restDuration:n(row.rest_duration_seconds,300), phase:s(row.phase)==="rest"?"rest":"work", countdownBeeps:b(row.countdown_beeps), trackCompletions:b(row.track_completions), dailyTarget:n(row.daily_target,1), completedToday:n(row.completed_today), completionDate:row.completion_date == null ? null : s(row.completion_date) }));
  const habitDays = new Map<number, number[]>();
  for (const row of rows(result[2])) (habitDays.get(n(row.habit_id)) || habitDays.set(n(row.habit_id), []).get(n(row.habit_id))!).push(n(row.weekday));
  const widgets = rows(result[1]).map(row => ({ id:n(row.id), name:s(row.name), type:s(row.kind)==="toggle"?"toggle":"counter", goal:n(row.goal,1), color:s(row.color), days:habitDays.get(n(row.id)) || [0,1,2,3,4,5,6] }));
  const logs: TempoState["logs"] = {};
  for (const row of rows(result[3])) { const date=s(row.log_date), id=habitLogKey(n(row.habit_id)); logs[date] ||= {}; logs[date][id]={name:s(row.name_snapshot),color:s(row.color_snapshot),type:s(row.kind_snapshot),goal:n(row.goal_snapshot,1),value:n(row.value),done:b(row.done)}; }
  const nutritionGoal = space.nutrition_calories == null ? null : {calories:n(space.nutrition_calories),carbs:n(space.nutrition_carbs),protein:n(space.nutrition_protein),fats:n(space.nutrition_fats),fibre:n(space.nutrition_fibre)};
  const foods = rows(result[4]).map(row=>({id:n(row.id),title:s(row.title),servingSize:n(row.serving_size,1),servingUnit:s(row.serving_unit,"g"),calories:n(row.calories),carbs:n(row.carbs),protein:n(row.protein),fats:n(row.fats),fibre:n(row.fibre)}));
  const itemsByMeal = new Map<number,Row[]>();
  for (const row of rows(result[6])) (itemsByMeal.get(n(row.meal_id)) || itemsByMeal.set(n(row.meal_id),[]).get(n(row.meal_id))!).push({foodId:n(row.food_id),servingSize:n(row.serving_size,1)});
  const meals = rows(result[5]).map(row=>({id:n(row.id),title:s(row.title),items:itemsByMeal.get(n(row.id))||[]}));
  const foodLogs: TempoState["foodLogs"] = {};
  for (const row of rows(result[7])) { const date=s(row.log_date); foodLogs[date] ||= []; foodLogs[date].push({id:n(row.id),foodId:row.food_id==null?"":n(row.food_id),mealId:row.meal_id==null?"":n(row.meal_id),servingSize:n(row.serving_size,1),loggedAt:n(row.logged_at),mealTitle:s(row.meal_title_snapshot),snapshot:{title:s(row.title_snapshot),servingSize:n(row.serving_size_snapshot,1),servingUnit:s(row.serving_unit_snapshot,"g"),calories:n(row.calories_snapshot),carbs:n(row.carbs_snapshot),protein:n(row.protein_snapshot),fats:n(row.fats_snapshot),fibre:n(row.fibre_snapshot)}}); }
  const exercisesByWorkout = new Map<number,Row[]>();
  for (const row of rows(result[9])) (exercisesByWorkout.get(n(row.workout_id)) || exercisesByWorkout.set(n(row.workout_id),[]).get(n(row.workout_id))!).push({id:n(row.id),name:s(row.name),muscleGroup:s(row.muscle_group),sets:n(row.planned_sets,1),reps:n(row.planned_reps),load:n(row.planned_load)});
  const workouts = rows(result[8]).map(row=>({id:n(row.id),name:s(row.name),exercises:exercisesByWorkout.get(n(row.id))||[]}));
  const mesocycles = rows(result[10]).map(row=>({id:n(row.id),name:s(row.name),progressionRate:n(row.progression_rate,.025),archived:n(row.id)!==space.active_mesocycle_id,workoutIds:[] as number[],weeks:[] as Row[],sessions:[] as Row[]}));
  const mesoById = new Map(mesocycles.map(item=>[item.id,item]));
  for (const row of rows(result[11])) mesoById.get(n(row.mesocycle_id))?.workoutIds.push(n(row.workout_id));
  for (const row of rows(result[12])) mesoById.get(n(row.mesocycle_id))?.weeks.push({deload:b(row.deload),completed:b(row.completed)});
  const sessions = new Map<number,Row>();
  for (const row of rows(result[13])) { const session:Row={id:n(row.id),templateId:row.workout_id==null?"":n(row.workout_id),name:s(row.name_snapshot),weekIndex:n(row.week_index),date:s(row.session_date),createdAt:n(row.created_at),status:s(row.status),unit:s(row.unit,"lb"),exercises:[]}; sessions.set(n(row.id),session); mesoById.get(n(row.mesocycle_id))?.sessions.push(session); }
  const sessionExercises = new Map<number,Row>();
  for (const row of rows(result[14])) { const exercise:Row={id:n(row.id),exerciseId:row.source_exercise_id==null?"":n(row.source_exercise_id),name:s(row.name_snapshot),muscleGroup:s(row.muscle_group_snapshot),mode:s(row.mode,"external"),bodyweightFactor:n(row.bodyweight_factor,1),unit:"lb",allocations:[],sets:[]}; sessionExercises.set(n(row.id),exercise); (sessions.get(n(row.session_id))?.exercises as Row[]|undefined)?.push(exercise); }
  for (const row of rows(result[15])) { const name=s(row.name_snapshot,"Other"); (sessionExercises.get(n(row.session_exercise_id))?.allocations as Row[]|undefined)?.push({muscleId:name.trim().toLocaleLowerCase(),name,share:n(row.share)}); }
  for (const row of rows(result[16])) (sessionExercises.get(n(row.session_exercise_id))?.sets as Row[]|undefined)?.push({id:n(row.id),reps:n(row.reps),load:n(row.load),completed:b(row.completed)});
  const recent=rows(result[7]).slice().sort((a,z)=>n(z.logged_at)-n(a.logged_at));
  return {schemaVersion:14,timers,widgets,logs,foods,meals,foodLogs,nutritionGoal,...recentNutritionIds(recent),strength:{unit:space.strength_unit||"lb",workouts,mesocycles,activeMesocycleId:space.active_mesocycle_id==null?"":String(space.active_mesocycle_id)},legacyDefaultsRemoved:true};
}

function insertOrUpdate(db:D1Database, table:string, id:unknown, columns:string[], values:unknown[], updateColumns=columns):D1PreparedStatement {
  const existing=dbId(id); const names=["space_id",...columns]; const marks=names.map(()=>"?").join(",");
  if (!existing) return db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${marks})`).bind(...values);
  const assignments=updateColumns.map(column=>`${column}=excluded.${column}`).join(",");
  return db.prepare(`INSERT INTO ${table} (id,${names.join(",")}) VALUES (?,${marks}) ON CONFLICT(id) DO UPDATE SET ${assignments} WHERE ${table}.space_id=excluded.space_id`).bind(existing,...values);
}

async function ownedIds(db: D1Database, spaceId: number): Promise<OwnedIds> {
  const tables: Array<[EntityKind, string]> = [["timer","timers"],["habit","habits"],["food","foods"],["meal","meals"],["foodLog","food_log_entries"],["workout","workouts"],["workoutExercise","workout_exercises"],["mesocycle","mesocycles"],["session","workout_sessions"],["sessionExercise","session_exercises"],["set","exercise_sets"]];
  const result = await db.batch(tables.map(([,table]) => db.prepare(`SELECT id FROM ${table} WHERE space_id=?`).bind(spaceId)));
  return Object.fromEntries(tables.map(([kind], index) => [kind, new Set(rows(result[index]).map(row => n(row.id)))]) ) as OwnedIds;
}

export async function replaceState(db:D1Database, space:SpaceRow, input:TempoState, expected:number):Promise<number|null> {
  const sid=space.id, now=Date.now(), token=crypto.randomUUID();
  const state=remapForeignStateIds(input,await ownedIds(db,sid));
  const staleBefore=now-15*60_000;
  const claim=await db.prepare("UPDATE spaces SET revision=revision+1,write_token=?,write_token_at=? WHERE id=? AND revision=? AND (write_token='' OR write_token_at IS NULL OR write_token_at<?)").bind(token,now,sid,expected,staleBefore).run();
  if(!claim.meta.changes)return null;
  const q:D1PreparedStatement[]=[];
  const goal=state.nutritionGoal;
  for (const table of ["habit_schedule_days","habit_daily_logs","meal_items","food_log_entries","mesocycle_workouts","mesocycle_weeks","exercise_sets","session_exercise_allocations","session_exercises","workout_sessions"])
    q.push(db.prepare(`DELETE FROM ${table} WHERE space_id=?`).bind(sid));
  for (const table of ["timers","habits","foods","meals","workout_exercises","workouts","mesocycles"])
    q.push(db.prepare(`UPDATE ${table} SET deleted_at=? WHERE space_id=? AND deleted_at IS NULL`).bind(now,sid));

  const timerOrder=new Map<string,number>(), habitOrder=new Map<string,number>(), foodOrder=new Map<string,number>(), mealOrder=new Map<string,number>(), workoutOrder=new Map<string,number>(), mesoOrder=new Map<string,number>(), exerciseLocation=new Map<string,[number,number]>();
  for (const [order,timer] of state.timers.entries()) { timerOrder.set(String(timer.id),order); q.push(insertOrUpdate(db,"timers",timer.id,["name","duration_seconds","remaining_seconds","color","running","checkpoint_at","pomodoro","rest_duration_seconds","phase","countdown_beeps","track_completions","daily_target","completed_today","completion_date","sort_order","deleted_at"],[sid,s(timer.name),Math.max(1,n(timer.duration,1)),Math.max(0,n(timer.remaining)),s(timer.color),timer.running===true?1:0,timer.lastTick==null?null:n(timer.lastTick),timer.pomodoro===true?1:0,Math.max(1,n(timer.restDuration,300)),timer.pomodoro===true&&timer.phase==="rest"?"rest":"work",timer.countdownBeeps===true?1:0,timer.trackCompletions===true?1:0,Math.max(1,Math.round(n(timer.dailyTarget,1))),Math.max(0,Math.round(n(timer.completedToday))),timer.completionDate==null?null:s(timer.completionDate),order,null])); }
  for (const [order,habit] of state.widgets.entries()) { habitOrder.set(String(habit.id),order); q.push(insertOrUpdate(db,"habits",habit.id,["name","kind","goal","color","sort_order","deleted_at"],[sid,s(habit.name),habit.type==="toggle"?"toggle":"counter",Math.max(1,n(habit.goal,1)),s(habit.color),order,null])); for(const day of (Array.isArray(habit.days)?habit.days:[0,1,2,3,4,5,6])) q.push(db.prepare("INSERT INTO habit_schedule_days (space_id,habit_id,weekday) SELECT ?,id,? FROM habits WHERE space_id=? AND sort_order=? AND deleted_at IS NULL").bind(sid,n(day),sid,order)); }
  const habitLogRows:Array<[string,string,Row]> = [];
  for (const [date,records] of Object.entries(state.logs)) for(const [key,record] of Object.entries(records)) { const parsed=parseLogKey(key); if (parsed || "value" in record || "done" in record || "type" in record) habitLogRows.push([date,parsed?.id??key,record]); }
  const missingHabits=habitLogRows.filter(([,key])=>!habitOrder.has(key)&&!dbId(key));
  for(const [,key,record] of missingHabits) q.push(db.prepare("INSERT INTO habits (space_id,name,kind,goal,color,sort_order,deleted_at) VALUES (?,?,?,?,?,-1,?)").bind(sid,s(record.name,`Habit ${key}`),record.type==="toggle"?"toggle":"counter",Math.max(1,n(record.goal,1)),s(record.color),now));
  const habitMissingIndex=new Map(missingHabits.map(([,key],i)=>[key,missingHabits.length-1-i]));
  for(const [date,key,record] of habitLogRows) { const order=habitOrder.get(key), id=dbId(key), offset=habitMissingIndex.get(key); const expr=order!=null?"(SELECT id FROM habits WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)":id?"?":"(SELECT id FROM habits WHERE space_id=? AND deleted_at=? ORDER BY id DESC LIMIT 1 OFFSET ?)"; const binds=order!=null?[sid,order]:id?[id]:[sid,now,offset]; q.push(db.prepare(`INSERT INTO habit_daily_logs (space_id,habit_id,log_date,name_snapshot,color_snapshot,kind_snapshot,goal_snapshot,value,done) VALUES (?,${expr},?,?,?,?,?,?,?)`).bind(sid,...binds,date,s(record.name),s(record.color),record.type==="toggle"?"toggle":"counter",Math.max(1,n(record.goal,1)),Math.max(0,n(record.value)),record.done===true?1:0)); }
  for(const [order,food] of state.foods.entries()){foodOrder.set(String(food.id),order);q.push(insertOrUpdate(db,"foods",food.id,["title","serving_size","serving_unit","calories","carbs","protein","fats","fibre","sort_order","deleted_at"],[sid,s(food.title),Math.max(.01,n(food.servingSize,1)),s(food.servingUnit,"g"),n(food.calories),n(food.carbs),n(food.protein),n(food.fats),n(food.fibre),order,null]));}
  for(const [order,meal] of state.meals.entries()){mealOrder.set(String(meal.id),order);q.push(insertOrUpdate(db,"meals",meal.id,["title","sort_order","deleted_at"],[sid,s(meal.title),order,null])); for(const [itemOrder,item] of (Array.isArray(meal.items)?meal.items as Row[]:[]).entries()){const fOrder=foodOrder.get(String(item.foodId)), fId=dbId(item.foodId);if(fOrder==null&&!fId)continue;const fExpr=fOrder!=null?"(SELECT id FROM foods WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)":"?";q.push(db.prepare(`INSERT INTO meal_items (space_id,meal_id,food_id,serving_size,sort_order) VALUES (?,(SELECT id FROM meals WHERE space_id=? AND sort_order=? AND deleted_at IS NULL),${fExpr},?,?)`).bind(sid,sid,order,...(fOrder!=null?[sid,fOrder]:[fId]),Math.max(.01,n(item.servingSize,1)),itemOrder));}}
  const foodByInput=new Map(state.foods.map(food=>[String(food.id),food]));
  for(const [date,entries] of Object.entries(state.foodLogs))for(const entry of entries){const snap=(entry.snapshot&&typeof entry.snapshot==="object"?entry.snapshot:foodByInput.get(String(entry.foodId))) as Row|undefined||{};const fOrder=foodOrder.get(String(entry.foodId)),mOrder=mealOrder.get(String(entry.mealId)),fId=dbId(entry.foodId),mId=dbId(entry.mealId);const fExpr=fOrder!=null?"(SELECT id FROM foods WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)":fId?"?":"NULL",mExpr=mOrder!=null?"(SELECT id FROM meals WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)":mId?"?":"NULL";const values=[sid,date,...(fOrder!=null?[sid,fOrder]:fId?[fId]:[]),...(mOrder!=null?[sid,mOrder]:mId?[mId]:[]),Math.max(.01,n(entry.servingSize,1)),n(entry.loggedAt),s(entry.mealTitle),s(snap.title,"Unknown food"),Math.max(.01,n(snap.servingSize,1)),s(snap.servingUnit,"g"),Math.max(0,n(snap.calories)),Math.max(0,n(snap.carbs)),Math.max(0,n(snap.protein)),Math.max(0,n(snap.fats)),Math.max(0,n(snap.fibre))];const existing=dbId(entry.id);const prefix=existing?"id,":"",prefixMark=existing?"?,":"";q.push(db.prepare(`INSERT INTO food_log_entries (${prefix}space_id,log_date,food_id,meal_id,serving_size,logged_at,meal_title_snapshot,title_snapshot,serving_size_snapshot,serving_unit_snapshot,calories_snapshot,carbs_snapshot,protein_snapshot,fats_snapshot,fibre_snapshot) VALUES (${prefixMark}?,?,${fExpr},${mExpr},?,?,?,?,?,?,?,?,?,?,?)`).bind(...(existing?[existing,...values]:values)));}
  for(const [order,workout] of state.strength.workouts.entries()){workoutOrder.set(String(workout.id),order);q.push(insertOrUpdate(db,"workouts",workout.id,["name","sort_order","deleted_at"],[sid,s(workout.name),order,null]));for(const [eOrder,exercise] of (Array.isArray(workout.exercises)?workout.exercises as Row[]:[]).entries()){exerciseLocation.set(String(exercise.id),[order,eOrder]);const wExpr="(SELECT id FROM workouts WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)";const existing=dbId(exercise.id);if(existing)q.push(db.prepare(`INSERT INTO workout_exercises (id,space_id,workout_id,name,muscle_group,planned_sets,planned_reps,planned_load,sort_order,deleted_at) VALUES (?,?,${wExpr},?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET workout_id=excluded.workout_id,name=excluded.name,muscle_group=excluded.muscle_group,planned_sets=excluded.planned_sets,planned_reps=excluded.planned_reps,planned_load=excluded.planned_load,sort_order=excluded.sort_order,deleted_at=NULL WHERE workout_exercises.space_id=excluded.space_id`).bind(existing,sid,sid,order,s(exercise.name),s(exercise.muscleGroup,"Other"),Math.max(1,n(exercise.sets,1)),Math.max(0,n(exercise.reps)),Math.max(0,n(exercise.load)),eOrder));else q.push(db.prepare(`INSERT INTO workout_exercises (space_id,workout_id,name,muscle_group,planned_sets,planned_reps,planned_load,sort_order,deleted_at) VALUES (?,${wExpr},?,?,?,?,?,?,NULL)`).bind(sid,sid,order,s(exercise.name),s(exercise.muscleGroup,"Other"),Math.max(1,n(exercise.sets,1)),Math.max(0,n(exercise.reps)),Math.max(0,n(exercise.load)),eOrder));}}
  for(const [order,meso] of state.strength.mesocycles.entries()){mesoOrder.set(String(meso.id),order);q.push(insertOrUpdate(db,"mesocycles",meso.id,["name","progression_rate","sort_order","deleted_at"],[sid,s(meso.name),Math.max(0,n(meso.progressionRate,.025)),order,null]));for(const [linkOrder,wid] of (Array.isArray(meso.workoutIds)?meso.workoutIds:[]).entries()){const wo=workoutOrder.get(String(wid)),wi=dbId(wid);if(wo==null&&!wi)continue;const expr=wo!=null?"(SELECT id FROM workouts WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)":"?";q.push(db.prepare(`INSERT INTO mesocycle_workouts (space_id,mesocycle_id,workout_id,sort_order) VALUES (?,(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL),${expr},?)`).bind(sid,sid,order,...(wo!=null?[sid,wo]:[wi]),linkOrder));}for(const [weekIndex,week] of (Array.isArray(meso.weeks)?meso.weeks as Row[]:[]).entries())q.push(db.prepare("INSERT INTO mesocycle_weeks (space_id,mesocycle_id,week_index,deload,completed) VALUES (?,(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL),?,?,?)").bind(sid,sid,order,weekIndex,week.deload===true?1:0,week.completed===true?1:0));for(const [sessionOrder,session] of (Array.isArray(meso.sessions)?meso.sessions as Row[]:[]).entries()){const wo=workoutOrder.get(String(session.templateId)),wi=dbId(session.templateId),wExpr=wo!=null?"(SELECT id FROM workouts WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)":wi?"?":"NULL",existing=dbId(session.id);const vals=[sid,...(wo!=null?[sid,wo]:wi?[wi]:[]),s(session.name),Math.max(0,n(session.weekIndex)),s(session.date),n(session.createdAt),session.status==="in-progress"?"in-progress":"completed",s(session.unit,"lb"),sessionOrder,sid,order];q.push(db.prepare(`INSERT INTO workout_sessions (${existing?"id,":""}space_id,workout_id,name_snapshot,week_index,session_date,created_at,status,unit,sort_order,mesocycle_id) VALUES (${existing?"?,":""}?,${wExpr},?,?,?,?,?,?,?,(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL))`).bind(...(existing?[existing,...vals]:vals)));for(const [seOrder,exercise] of (Array.isArray(session.exercises)?session.exercises as Row[]:[]).entries()){const loc=exerciseLocation.get(String(exercise.exerciseId)),sourceId=dbId(exercise.exerciseId),sourceExpr=loc?"(SELECT e.id FROM workout_exercises e JOIN workouts w ON w.id=e.workout_id WHERE e.space_id=? AND w.sort_order=? AND e.sort_order=? AND e.deleted_at IS NULL)":sourceId?"?":"NULL",seId=dbId(exercise.id),seVals=[sid,...(loc?[sid,...loc]:sourceId?[sourceId]:[]),s(exercise.name),s(exercise.muscleGroup,"Other"),s(exercise.mode,"external"),Math.max(0,n(exercise.bodyweightFactor,1)),seOrder,sid,sid,order,sessionOrder];q.push(db.prepare(`INSERT INTO session_exercises (${seId?"id,":""}space_id,source_exercise_id,name_snapshot,muscle_group_snapshot,mode,bodyweight_factor,sort_order,session_id) VALUES (${seId?"?,":""}?,${sourceExpr},?,?,?,?,?,(SELECT id FROM workout_sessions WHERE space_id=? AND mesocycle_id=(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL) AND sort_order=?))`).bind(...(seId?[seId,...seVals]:seVals)));
  for(const [aOrder,a] of (Array.isArray(exercise.allocations)?exercise.allocations as Row[]:[]).entries())q.push(db.prepare("INSERT INTO session_exercise_allocations (space_id,session_exercise_id,name_snapshot,share,sort_order) VALUES (?,(SELECT id FROM session_exercises WHERE space_id=? AND session_id=(SELECT id FROM workout_sessions WHERE space_id=? AND mesocycle_id=(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL) AND sort_order=?) AND sort_order=?),?,?,?)").bind(sid,sid,sid,sid,order,sessionOrder,seOrder,s(a.name,"Other"),Math.max(0,n(a.share)),aOrder));
  for(const [setOrder,set] of (Array.isArray(exercise.sets)?exercise.sets as Row[]:[]).entries()){const setId=dbId(set.id),setVals=[sid,Math.max(0,n(set.reps)),Math.max(0,n(set.load)),set.completed===true?1:0,setOrder,sid,sid,sid,order,sessionOrder,seOrder];q.push(db.prepare(`INSERT INTO exercise_sets (${setId?"id,":""}space_id,reps,load,completed,sort_order,session_exercise_id) VALUES (${setId?"?,":""}?,?,?,?,?,(SELECT id FROM session_exercises WHERE space_id=? AND session_id=(SELECT id FROM workout_sessions WHERE space_id=? AND mesocycle_id=(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL) AND sort_order=?) AND sort_order=?))`).bind(...(setId?[setId,...setVals]:setVals)));}}}}
  const activeOrder=mesoOrder.get(String(state.strength.activeMesocycleId)),activeId=dbId(state.strength.activeMesocycleId),activeExpr=activeOrder!=null?"(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)":activeId?"(SELECT id FROM mesocycles WHERE id=? AND space_id=? AND deleted_at IS NULL)":"NULL";
  const activeBinds=activeOrder!=null?[sid,activeOrder]:activeId?[activeId,sid]:[];
  q.push(db.prepare(`UPDATE spaces SET active_mesocycle_id=${activeExpr},strength_unit='lb',nutrition_calories=?,nutrition_carbs=?,nutrition_protein=?,nutrition_fats=?,nutrition_fibre=?,write_token='',write_token_at=NULL WHERE id=? AND write_token=?`).bind(...activeBinds,goal?Math.max(0,n(goal.calories)):null,goal?Math.max(0,n(goal.carbs)):null,goal?Math.max(0,n(goal.protein)):null,goal?Math.max(0,n(goal.fats)):null,goal?Math.max(0,n(goal.fibre)):null,sid,token));
  try { await db.batch(q); return expected+1; }
  catch (cause) { await db.prepare("UPDATE spaces SET write_token='',write_token_at=NULL WHERE id=? AND write_token=?").bind(sid,token).run().catch(()=>undefined); throw cause; }
}
