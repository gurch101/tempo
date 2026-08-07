import type { SpaceRow, TempoState } from "./types";
import { parseLogKey } from "./log-keys";
import { readFoodLogs, readFoods, readHabitLogs, readHabits, readMeals, readTimers } from "./repository";

type Row = Record<string, unknown>;
const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const s = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const b = (value: unknown) => value === true || value === 1;
const dbId = (value: unknown): number | null => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function claim(db: D1Database, space: SpaceRow, expected: number) {
  const token=crypto.randomUUID(), now=Date.now(), staleBefore=now-15*60_000;
  const result=await db.prepare("UPDATE spaces SET revision=revision+1,write_token=?,write_token_at=? WHERE id=? AND revision=? AND (write_token='' OR write_token_at IS NULL OR write_token_at<?)")
    .bind(token,now,space.id,expected,staleBefore).run();
  return result.meta.changes ? token : null;
}

async function commit(db: D1Database, spaceId: number, token: string, statements: D1PreparedStatement[]) {
  statements.push(db.prepare("UPDATE spaces SET write_token='',write_token_at=NULL WHERE id=? AND write_token=?").bind(spaceId,token));
  try { await db.batch(statements); }
  catch (cause) { await db.prepare("UPDATE spaces SET write_token='',write_token_at=NULL WHERE id=? AND write_token=?").bind(spaceId,token).run().catch(()=>undefined); throw cause; }
}

function deleteMissing(db:D1Database,table:string,spaceId:number,ids:number[],soft=false) {
  const suffix=ids.length?` AND id NOT IN (${ids.map(()=>"?").join(",")})`:"";
  return db.prepare(`${soft?`UPDATE ${table} SET deleted_at=?`:`DELETE FROM ${table}`} WHERE space_id=?${soft?" AND deleted_at IS NULL":""}${suffix}`)
    .bind(...(soft?[Date.now(),spaceId,...ids]:[spaceId,...ids]));
}

function timerValues(timer:Row, order:number) {
  return [s(timer.name),Math.max(1,n(timer.duration,1)),Math.max(0,n(timer.remaining)),s(timer.color),b(timer.running)?1:0,timer.lastTick==null?null:n(timer.lastTick),b(timer.pomodoro)?1:0,Math.max(1,n(timer.restDuration,300)),b(timer.pomodoro)&&timer.phase==="rest"?"rest":"work",b(timer.countdownBeeps)?1:0,b(timer.trackCompletions)?1:0,Math.max(1,Math.round(n(timer.dailyTarget,1))),Math.max(0,Math.round(n(timer.completedToday))),timer.completionDate==null?null:s(timer.completionDate),order];
}

export async function writeTimers(db:D1Database,space:SpaceRow,input:TempoState["timers"],expected:number) {
  const current=await readTimers(db,space.id), owned=new Set(current.map(item=>n(item.id)));
  const existingIds=input.map(item=>dbId(item.id)).filter((id):id is number=>id!==null&&owned.has(id));
  const structural=!same(current.map(item=>n(item.id)),existingIds) || input.length!==existingIds.length;
  const token=await claim(db,space,expected); if(!token)return null;
  const q:D1PreparedStatement[]=[];
  if(structural&&current.length)q.push(db.prepare("UPDATE timers SET sort_order=sort_order+1000000 WHERE space_id=? AND deleted_at IS NULL").bind(space.id));
  q.push(deleteMissing(db,"timers",space.id,existingIds,true));
  input.forEach((timer,order)=>{
    const values=timerValues(timer,order), id=dbId(timer.id);
    if(id&&owned.has(id)) q.push(db.prepare(`UPDATE timers SET name=?,duration_seconds=?,remaining_seconds=?,color=?,running=?,checkpoint_at=?,pomodoro=?,rest_duration_seconds=?,phase=?,countdown_beeps=?,track_completions=?,daily_target=?,completed_today=?,completion_date=?,sort_order=?,deleted_at=NULL WHERE id=? AND space_id=? AND (name IS NOT ? OR duration_seconds IS NOT ? OR remaining_seconds IS NOT ? OR color IS NOT ? OR running IS NOT ? OR checkpoint_at IS NOT ? OR pomodoro IS NOT ? OR rest_duration_seconds IS NOT ? OR phase IS NOT ? OR countdown_beeps IS NOT ? OR track_completions IS NOT ? OR daily_target IS NOT ? OR completed_today IS NOT ? OR completion_date IS NOT ? OR sort_order IS NOT ? OR deleted_at IS NOT NULL)`).bind(...values,id,space.id,...values));
    else q.push(db.prepare("INSERT INTO timers (space_id,name,duration_seconds,remaining_seconds,color,running,checkpoint_at,pomodoro,rest_duration_seconds,phase,countdown_beeps,track_completions,daily_target,completed_today,completion_date,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(space.id,...values));
  });
  await commit(db,space.id,token,q); return expected+1;
}

export async function writeHabits(db:D1Database,space:SpaceRow,input:TempoState["widgets"],expected:number) {
  const current=await readHabits(db,space.id), owned=new Set(current.map(item=>n(item.id))), byId=new Map(current.map(item=>[n(item.id),item]));
  const existingIds=input.map(item=>dbId(item.id)).filter((id):id is number=>id!==null&&owned.has(id));
  const structural=!same(current.map(item=>n(item.id)),existingIds)||input.length!==existingIds.length;
  const token=await claim(db,space,expected); if(!token)return null; const q:D1PreparedStatement[]=[];
  if(structural&&current.length)q.push(db.prepare("UPDATE habits SET sort_order=sort_order+1000000 WHERE space_id=? AND deleted_at IS NULL").bind(space.id));
  q.push(deleteMissing(db,"habits",space.id,existingIds,true));
  input.forEach((habit,order)=>{
    const values=[s(habit.name),habit.type==="toggle"?"toggle":"counter",Math.max(1,n(habit.goal,1)),s(habit.color),order], id=dbId(habit.id), days=(Array.isArray(habit.days)?habit.days:[0,1,2,3,4,5,6]).map(day=>n(day)).sort();
    if(id&&owned.has(id)) {
      q.push(db.prepare("UPDATE habits SET name=?,kind=?,goal=?,color=?,sort_order=?,deleted_at=NULL WHERE id=? AND space_id=? AND (name IS NOT ? OR kind IS NOT ? OR goal IS NOT ? OR color IS NOT ? OR sort_order IS NOT ? OR deleted_at IS NOT NULL)").bind(...values,id,space.id,...values));
      if(!same((byId.get(id)?.days as number[]).slice().sort(),days)){q.push(db.prepare("DELETE FROM habit_schedule_days WHERE space_id=? AND habit_id=?").bind(space.id,id));days.forEach(day=>q.push(db.prepare("INSERT INTO habit_schedule_days(space_id,habit_id,weekday) VALUES(?,?,?)").bind(space.id,id,day)));}
    } else {
      q.push(db.prepare("INSERT INTO habits(space_id,name,kind,goal,color,sort_order) VALUES(?,?,?,?,?,?)").bind(space.id,...values));
      days.forEach(day=>q.push(db.prepare("INSERT INTO habit_schedule_days(space_id,habit_id,weekday) SELECT ?,id,? FROM habits WHERE space_id=? AND sort_order=? AND deleted_at IS NULL").bind(space.id,day,space.id,order)));
    }
  });
  await commit(db,space.id,token,q);return expected+1;
}

export async function writeFoods(db:D1Database,space:SpaceRow,input:TempoState["foods"],expected:number) {
  const current=await readFoods(db,space.id),owned=new Set(current.map(item=>n(item.id))),existingIds=input.map(item=>dbId(item.id)).filter((id):id is number=>id!==null&&owned.has(id));
  const structural=!same(current.map(item=>n(item.id)),existingIds)||input.length!==existingIds.length;
  const token=await claim(db,space,expected);if(!token)return null;const q:D1PreparedStatement[]=[];
  if(structural&&current.length)q.push(db.prepare("UPDATE foods SET sort_order=sort_order+1000000 WHERE space_id=? AND deleted_at IS NULL").bind(space.id));
  q.push(deleteMissing(db,"foods",space.id,existingIds,true));
  input.forEach((food,order)=>{const values=[s(food.title),Math.max(.01,n(food.servingSize,1)),s(food.servingUnit,"g"),Math.max(0,n(food.calories)),Math.max(0,n(food.carbs)),Math.max(0,n(food.protein)),Math.max(0,n(food.fats)),Math.max(0,n(food.fibre)),order],id=dbId(food.id);
    if(id&&owned.has(id))q.push(db.prepare("UPDATE foods SET title=?,serving_size=?,serving_unit=?,calories=?,carbs=?,protein=?,fats=?,fibre=?,sort_order=?,deleted_at=NULL WHERE id=? AND space_id=? AND (title IS NOT ? OR serving_size IS NOT ? OR serving_unit IS NOT ? OR calories IS NOT ? OR carbs IS NOT ? OR protein IS NOT ? OR fats IS NOT ? OR fibre IS NOT ? OR sort_order IS NOT ? OR deleted_at IS NOT NULL)").bind(...values,id,space.id,...values));
    else q.push(db.prepare("INSERT INTO foods(space_id,title,serving_size,serving_unit,calories,carbs,protein,fats,fibre,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(space.id,...values));});
  await commit(db,space.id,token,q);return expected+1;
}

export async function writeMeals(db:D1Database,space:SpaceRow,input:TempoState["meals"],expected:number) {
  const current=await readMeals(db,space.id),owned=new Set(current.map(item=>n(item.id))),byId=new Map(current.map(item=>[n(item.id),item])),existingIds=input.map(item=>dbId(item.id)).filter((id):id is number=>id!==null&&owned.has(id));
  const structural=!same(current.map(item=>n(item.id)),existingIds)||input.length!==existingIds.length;
  const token=await claim(db,space,expected);if(!token)return null;const q:D1PreparedStatement[]=[];
  if(structural&&current.length)q.push(db.prepare("UPDATE meals SET sort_order=sort_order+1000000 WHERE space_id=? AND deleted_at IS NULL").bind(space.id));
  q.push(deleteMissing(db,"meals",space.id,existingIds,true));
  input.forEach((meal,order)=>{const id=dbId(meal.id),title=s(meal.title),items=(Array.isArray(meal.items)?meal.items:[]) as Row[];
    if(id&&owned.has(id)){q.push(db.prepare("UPDATE meals SET title=?,sort_order=?,deleted_at=NULL WHERE id=? AND space_id=? AND (title IS NOT ? OR sort_order IS NOT ? OR deleted_at IS NOT NULL)").bind(title,order,id,space.id,title,order));const normalized=(value:unknown)=>((Array.isArray(value)?value:[])as Row[]).map(item=>({foodId:dbId(item.foodId),servingSize:Math.max(.01,n(item.servingSize,1))}));if(!same(normalized(byId.get(id)?.items),normalized(items))){q.push(db.prepare("DELETE FROM meal_items WHERE space_id=? AND meal_id=?").bind(space.id,id));items.forEach((item,itemOrder)=>{const foodId=dbId(item.foodId);if(foodId)q.push(db.prepare("INSERT INTO meal_items(space_id,meal_id,food_id,serving_size,sort_order) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM foods WHERE id=? AND space_id=? AND deleted_at IS NULL)").bind(space.id,id,foodId,Math.max(.01,n(item.servingSize,1)),itemOrder,foodId,space.id));});}}
    else {q.push(db.prepare("INSERT INTO meals(space_id,title,sort_order) VALUES(?,?,?)").bind(space.id,title,order));items.forEach((item,itemOrder)=>{const foodId=dbId(item.foodId);if(foodId)q.push(db.prepare("INSERT INTO meal_items(space_id,meal_id,food_id,serving_size,sort_order) SELECT ?,m.id,?,?,? FROM meals m JOIN foods f ON f.id=? AND f.space_id=? AND f.deleted_at IS NULL WHERE m.space_id=? AND m.sort_order=? AND m.deleted_at IS NULL").bind(space.id,foodId,Math.max(.01,n(item.servingSize,1)),itemOrder,foodId,space.id,space.id,order));});}});
  await commit(db,space.id,token,q);return expected+1;
}

function flattenHabitLogs(logs:TempoState["logs"]){const result=new Map<string,{date:string;habitId:number;record:Row}>();for(const[date,records]of Object.entries(logs))for(const[key,record]of Object.entries(records)){const parsed=parseLogKey(key),habitId=dbId(parsed?.id??key);if(habitId)result.set(`${date}:${habitId}`,{date,habitId,record});}return result;}
export async function writeHabitLogs(db:D1Database,space:SpaceRow,input:TempoState["logs"],expected:number) {
  const current=flattenHabitLogs(await readHabitLogs(db,space.id)),next=flattenHabitLogs(input),token=await claim(db,space,expected);if(!token)return null;const q:D1PreparedStatement[]=[];
  for(const[key,item]of current)if(!next.has(key))q.push(db.prepare("DELETE FROM habit_daily_logs WHERE space_id=? AND habit_id=? AND log_date=?").bind(space.id,item.habitId,item.date));
  for(const[key,{date,habitId,record}]of next){const old=current.get(key)?.record;if(old&&same(old,record))continue;q.push(db.prepare(`INSERT INTO habit_daily_logs(space_id,habit_id,log_date,name_snapshot,color_snapshot,kind_snapshot,goal_snapshot,value,done) SELECT ?,id,?,?,?,?,?,?,? FROM habits WHERE id=? AND space_id=? ON CONFLICT(space_id,habit_id,log_date) DO UPDATE SET name_snapshot=excluded.name_snapshot,color_snapshot=excluded.color_snapshot,kind_snapshot=excluded.kind_snapshot,goal_snapshot=excluded.goal_snapshot,value=excluded.value,done=excluded.done`).bind(space.id,date,s(record.name),s(record.color),record.type==="toggle"?"toggle":"counter",Math.max(1,n(record.goal,1)),Math.max(0,n(record.value)),b(record.done)?1:0,habitId,space.id));}
  await commit(db,space.id,token,q);return expected+1;
}

export async function writeHabitLog(db:D1Database,space:SpaceRow,date:string,habitId:number,record:Row,expected:number){
  const owner=await db.prepare("SELECT id FROM habits WHERE id=? AND space_id=?").bind(habitId,space.id).first();if(!owner)return undefined;
  const token=await claim(db,space,expected);if(!token)return null;
  await commit(db,space.id,token,[db.prepare(`INSERT INTO habit_daily_logs(space_id,habit_id,log_date,name_snapshot,color_snapshot,kind_snapshot,goal_snapshot,value,done) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(space_id,habit_id,log_date) DO UPDATE SET name_snapshot=excluded.name_snapshot,color_snapshot=excluded.color_snapshot,kind_snapshot=excluded.kind_snapshot,goal_snapshot=excluded.goal_snapshot,value=excluded.value,done=excluded.done WHERE name_snapshot IS NOT excluded.name_snapshot OR color_snapshot IS NOT excluded.color_snapshot OR kind_snapshot IS NOT excluded.kind_snapshot OR goal_snapshot IS NOT excluded.goal_snapshot OR value IS NOT excluded.value OR done IS NOT excluded.done`).bind(space.id,habitId,date,s(record.name),s(record.color),record.type==="toggle"?"toggle":"counter",Math.max(1,n(record.goal,1)),Math.max(0,n(record.value)),b(record.done)?1:0)]);
  return{revision:expected+1,record};
}

function flattenFoodLogs(logs:TempoState["foodLogs"]){const result=new Map<number,{date:string;entry:Row}>();for(const[date,entries]of Object.entries(logs))for(const entry of entries){const id=dbId(entry.id);if(id)result.set(id,{date,entry});}return result;}
function foodLogValues(date:string,entry:Row){const snap=(entry.snapshot&&typeof entry.snapshot==="object"?entry.snapshot:{})as Row;return[date,dbId(entry.foodId),dbId(entry.mealId),Math.max(.01,n(entry.servingSize,1)),n(entry.loggedAt),s(entry.mealTitle),s(snap.title,"Unknown food"),Math.max(.01,n(snap.servingSize,1)),s(snap.servingUnit,"g"),Math.max(0,n(snap.calories)),Math.max(0,n(snap.carbs)),Math.max(0,n(snap.protein)),Math.max(0,n(snap.fats)),Math.max(0,n(snap.fibre))];}
export async function writeFoodLogs(db:D1Database,space:SpaceRow,input:TempoState["foodLogs"],expected:number){const currentData=await readFoodLogs(db,space.id),current=flattenFoodLogs(currentData.foodLogs),next=flattenFoodLogs(input),token=await claim(db,space,expected);if(!token)return null;const q:D1PreparedStatement[]=[];
  for(const id of current.keys())if(!next.has(id))q.push(db.prepare("DELETE FROM food_log_entries WHERE id=? AND space_id=?").bind(id,space.id));
  for(const[id,{date,entry}]of next){const old=current.get(id),values=foodLogValues(date,entry);if(old&&same(foodLogValues(old.date,old.entry),values))continue;q.push(db.prepare("UPDATE food_log_entries SET log_date=?,food_id=?,meal_id=?,serving_size=?,logged_at=?,meal_title_snapshot=?,title_snapshot=?,serving_size_snapshot=?,serving_unit_snapshot=?,calories_snapshot=?,carbs_snapshot=?,protein_snapshot=?,fats_snapshot=?,fibre_snapshot=? WHERE id=? AND space_id=?").bind(...values,id,space.id));}
  for(const[date,entries]of Object.entries(input))for(const entry of entries)if(!dbId(entry.id)){const values=foodLogValues(date,entry);q.push(db.prepare("INSERT INTO food_log_entries(space_id,log_date,food_id,meal_id,serving_size,logged_at,meal_title_snapshot,title_snapshot,serving_size_snapshot,serving_unit_snapshot,calories_snapshot,carbs_snapshot,protein_snapshot,fats_snapshot,fibre_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(space.id,...values));}
  await commit(db,space.id,token,q);return expected+1;}

export async function writeNutritionGoal(db:D1Database,space:SpaceRow,goal:TempoState["nutritionGoal"],expected:number){const token=await claim(db,space,expected);if(!token)return null;const values=goal?[Math.max(0,n(goal.calories)),Math.max(0,n(goal.carbs)),Math.max(0,n(goal.protein)),Math.max(0,n(goal.fats)),Math.max(0,n(goal.fibre))]:[null,null,null,null,null];await commit(db,space.id,token,[db.prepare("UPDATE spaces SET nutrition_calories=?,nutrition_carbs=?,nutrition_protein=?,nutrition_fats=?,nutrition_fibre=? WHERE id=? AND (nutrition_calories IS NOT ? OR nutrition_carbs IS NOT ? OR nutrition_protein IS NOT ? OR nutrition_fats IS NOT ? OR nutrition_fibre IS NOT ?)").bind(...values,space.id,...values)]);return expected+1;}

export async function createExerciseSet(db:D1Database,space:SpaceRow,sessionExerciseId:number,set:Row,expected:number){
  const owner=await db.prepare("SELECT id FROM session_exercises WHERE id=? AND space_id=?").bind(sessionExerciseId,space.id).first();if(!owner)return undefined;
  const token=await claim(db,space,expected);if(!token)return null;
  const insert=db.prepare("INSERT INTO exercise_sets(space_id,session_exercise_id,reps,load,completed,sort_order) VALUES(?,?,?,?,?,?)").bind(space.id,sessionExerciseId,Math.max(0,n(set.reps)),Math.max(0,n(set.load)),b(set.completed)?1:0,Math.max(0,n(set.sortOrder)));
  const release=db.prepare("UPDATE spaces SET write_token='',write_token_at=NULL WHERE id=? AND write_token=?").bind(space.id,token);
  try{const results=await db.batch([insert,release]);return{revision:expected+1,id:Number(results[0].meta.last_row_id)};}catch(cause){await db.prepare("UPDATE spaces SET write_token='',write_token_at=NULL WHERE id=? AND write_token=?").bind(space.id,token).run().catch(()=>undefined);throw cause;}
}

export async function updateExerciseSet(db:D1Database,space:SpaceRow,setId:number,set:Row,expected:number){
  const owner=await db.prepare("SELECT id FROM exercise_sets WHERE id=? AND space_id=?").bind(setId,space.id).first();if(!owner)return undefined;
  const token=await claim(db,space,expected);if(!token)return null;
  await commit(db,space.id,token,[db.prepare("UPDATE exercise_sets SET reps=?,load=?,completed=? WHERE id=? AND space_id=? AND (reps IS NOT ? OR load IS NOT ? OR completed IS NOT ?)").bind(Math.max(0,n(set.reps)),Math.max(0,n(set.load)),b(set.completed)?1:0,setId,space.id,Math.max(0,n(set.reps)),Math.max(0,n(set.load)),b(set.completed)?1:0)]);
  return{revision:expected+1,id:setId};
}

export async function removeExerciseSet(db:D1Database,space:SpaceRow,setId:number,expected:number){
  const owner=await db.prepare("SELECT id FROM exercise_sets WHERE id=? AND space_id=?").bind(setId,space.id).first();if(!owner)return undefined;
  const token=await claim(db,space,expected);if(!token)return null;
  await commit(db,space.id,token,[db.prepare("DELETE FROM exercise_sets WHERE id=? AND space_id=?").bind(setId,space.id)]);return{revision:expected+1,id:setId};
}

export async function writeStrength(db:D1Database,space:SpaceRow,strength:TempoState["strength"],expected:number){
  const token=await claim(db,space,expected);if(!token)return null;const sid=space.id,now=Date.now(),q:D1PreparedStatement[]=[];
  for(const table of["mesocycle_workouts","mesocycle_weeks","exercise_sets","session_exercise_allocations","session_exercises","workout_sessions"])q.push(db.prepare(`DELETE FROM ${table} WHERE space_id=?`).bind(sid));
  for(const table of["workout_exercises","workouts","mesocycles"])q.push(db.prepare(`UPDATE ${table} SET deleted_at=? WHERE space_id=? AND deleted_at IS NULL`).bind(now,sid));
  const workoutOrder=new Map<string,number>(),mesoOrder=new Map<string,number>(),exerciseLocation=new Map<string,[number,number]>();
  for(const[order,workout]of strength.workouts.entries()){
    workoutOrder.set(String(workout.id),order);const wid=dbId(workout.id);
    if(wid)q.push(db.prepare("INSERT INTO workouts(id,space_id,name,sort_order,deleted_at) VALUES(?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,sort_order=excluded.sort_order,deleted_at=NULL WHERE workouts.space_id=excluded.space_id").bind(wid,sid,s(workout.name),order));else q.push(db.prepare("INSERT INTO workouts(space_id,name,sort_order) VALUES(?,?,?)").bind(sid,s(workout.name),order));
    for(const[eOrder,exercise]of(Array.isArray(workout.exercises)?workout.exercises as Row[]:[]).entries()){
      exerciseLocation.set(String(exercise.id),[order,eOrder]);const id=dbId(exercise.id),values=[sid,sid,order,s(exercise.name),s(exercise.muscleGroup,"Other"),Math.max(1,n(exercise.sets,1)),Math.max(0,n(exercise.reps)),Math.max(0,n(exercise.load)),eOrder];
      if(id)q.push(db.prepare("INSERT INTO workout_exercises(id,space_id,workout_id,name,muscle_group,planned_sets,planned_reps,planned_load,sort_order,deleted_at) VALUES(?,?,(SELECT id FROM workouts WHERE space_id=? AND sort_order=? AND deleted_at IS NULL),?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET workout_id=excluded.workout_id,name=excluded.name,muscle_group=excluded.muscle_group,planned_sets=excluded.planned_sets,planned_reps=excluded.planned_reps,planned_load=excluded.planned_load,sort_order=excluded.sort_order,deleted_at=NULL WHERE workout_exercises.space_id=excluded.space_id").bind(id,...values));else q.push(db.prepare("INSERT INTO workout_exercises(space_id,workout_id,name,muscle_group,planned_sets,planned_reps,planned_load,sort_order) VALUES(?,(SELECT id FROM workouts WHERE space_id=? AND sort_order=? AND deleted_at IS NULL),?,?,?,?,?,?)").bind(...values));
    }
  }
  for(const[order,meso]of strength.mesocycles.entries()){
    mesoOrder.set(String(meso.id),order);const mid=dbId(meso.id);
    if(mid)q.push(db.prepare("INSERT INTO mesocycles(id,space_id,name,progression_rate,sort_order,deleted_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,progression_rate=excluded.progression_rate,sort_order=excluded.sort_order,deleted_at=NULL WHERE mesocycles.space_id=excluded.space_id").bind(mid,sid,s(meso.name),Math.max(0,n(meso.progressionRate,.025)),order));else q.push(db.prepare("INSERT INTO mesocycles(space_id,name,progression_rate,sort_order) VALUES(?,?,?,?)").bind(sid,s(meso.name),Math.max(0,n(meso.progressionRate,.025)),order));
    for(const[linkOrder,widValue]of(Array.isArray(meso.workoutIds)?meso.workoutIds:[]).entries()){const wo=workoutOrder.get(String(widValue)),wid=dbId(widValue);if(wo==null&&!wid)continue;const expr=wo!=null?"(SELECT id FROM workouts WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)":"?";q.push(db.prepare(`INSERT INTO mesocycle_workouts(space_id,mesocycle_id,workout_id,sort_order) VALUES(?,(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL),${expr},?)`).bind(sid,sid,order,...(wo!=null?[sid,wo]:[wid]),linkOrder));}
    for(const[weekIndex,week]of(Array.isArray(meso.weeks)?meso.weeks as Row[]:[]).entries())q.push(db.prepare("INSERT INTO mesocycle_weeks(space_id,mesocycle_id,week_index,deload,completed) VALUES(?,(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL),?,?,?)").bind(sid,sid,order,weekIndex,b(week.deload)?1:0,b(week.completed)?1:0));
    for(const[sessionOrder,session]of(Array.isArray(meso.sessions)?meso.sessions as Row[]:[]).entries()){
      const wo=workoutOrder.get(String(session.templateId)),wid=dbId(session.templateId),wExpr=wo!=null?"(SELECT id FROM workouts WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)":wid?"?":"NULL",sessionId=dbId(session.id),values=[sid,...(wo!=null?[sid,wo]:wid?[wid]:[]),s(session.name),Math.max(0,n(session.weekIndex)),s(session.date),n(session.createdAt),session.status==="in-progress"?"in-progress":"completed","lb",sessionOrder,sid,order];
      q.push(db.prepare(`INSERT INTO workout_sessions(${sessionId?"id,":""}space_id,workout_id,name_snapshot,week_index,session_date,created_at,status,unit,sort_order,mesocycle_id) VALUES(${sessionId?"?,":""}?,${wExpr},?,?,?,?,?,?,?,(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL))`).bind(...(sessionId?[sessionId,...values]:values)));
      for(const[exerciseOrder,exercise]of(Array.isArray(session.exercises)?session.exercises as Row[]:[]).entries()){
        const loc=exerciseLocation.get(String(exercise.exerciseId)),sourceId=dbId(exercise.exerciseId),sourceExpr=loc?"(SELECT e.id FROM workout_exercises e JOIN workouts w ON w.id=e.workout_id WHERE e.space_id=? AND w.sort_order=? AND e.sort_order=? AND e.deleted_at IS NULL)":sourceId?"?":"NULL",exerciseId=dbId(exercise.id),exerciseValues=[sid,...(loc?[sid,...loc]:sourceId?[sourceId]:[]),s(exercise.name),s(exercise.muscleGroup,"Other"),s(exercise.mode,"external"),Math.max(0,n(exercise.bodyweightFactor,1)),exerciseOrder,sid,sid,order,sessionOrder];
        q.push(db.prepare(`INSERT INTO session_exercises(${exerciseId?"id,":""}space_id,source_exercise_id,name_snapshot,muscle_group_snapshot,mode,bodyweight_factor,sort_order,session_id) VALUES(${exerciseId?"?,":""}?,${sourceExpr},?,?,?,?,?,(SELECT id FROM workout_sessions WHERE space_id=? AND mesocycle_id=(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL) AND sort_order=?))`).bind(...(exerciseId?[exerciseId,...exerciseValues]:exerciseValues)));
        for(const[allocationOrder,allocation]of(Array.isArray(exercise.allocations)?exercise.allocations as Row[]:[]).entries())q.push(db.prepare("INSERT INTO session_exercise_allocations(space_id,session_exercise_id,name_snapshot,share,sort_order) VALUES(?,(SELECT id FROM session_exercises WHERE space_id=? AND session_id=(SELECT id FROM workout_sessions WHERE space_id=? AND mesocycle_id=(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL) AND sort_order=?) AND sort_order=?),?,?,?)").bind(sid,sid,sid,sid,order,sessionOrder,exerciseOrder,s(allocation.name,"Other"),Math.max(0,n(allocation.share)),allocationOrder));
        for(const[setOrder,set]of(Array.isArray(exercise.sets)?exercise.sets as Row[]:[]).entries()){const setId=dbId(set.id),setValues=[sid,Math.max(0,n(set.reps)),Math.max(0,n(set.load)),b(set.completed)?1:0,setOrder,sid,sid,sid,order,sessionOrder,exerciseOrder];q.push(db.prepare(`INSERT INTO exercise_sets(${setId?"id,":""}space_id,reps,load,completed,sort_order,session_exercise_id) VALUES(${setId?"?,":""}?,?,?,?,?,(SELECT id FROM session_exercises WHERE space_id=? AND session_id=(SELECT id FROM workout_sessions WHERE space_id=? AND mesocycle_id=(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL) AND sort_order=?) AND sort_order=?))`).bind(...(setId?[setId,...setValues]:setValues)));}
      }
    }
  }
  const activeOrder=mesoOrder.get(String(strength.activeMesocycleId)),activeId=dbId(strength.activeMesocycleId),activeExpr=activeOrder!=null?"(SELECT id FROM mesocycles WHERE space_id=? AND sort_order=? AND deleted_at IS NULL)":activeId?"(SELECT id FROM mesocycles WHERE id=? AND space_id=? AND deleted_at IS NULL)":"NULL",activeBinds=activeOrder!=null?[sid,activeOrder]:activeId?[activeId,sid]:[];
  q.push(db.prepare(`UPDATE spaces SET active_mesocycle_id=${activeExpr},strength_unit='lb' WHERE id=?`).bind(...activeBinds,sid));await commit(db,sid,token,q);return expected+1;
}
