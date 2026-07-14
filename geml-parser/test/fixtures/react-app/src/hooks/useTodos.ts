import { useCallback, useReducer } from "react";
import { addTodo, seedTodos, todosReducer, toggleTodo } from "../state/todosReducer";

export function useTodos() {
  const [todos, dispatch] = useReducer(todosReducer, undefined, seedTodos);
  const toggle = useCallback((id: string) => {
    // dispatch() -> reducer case: the Redux-style indirection blind spot.
    dispatch(toggleTodo(id));
  }, []);
  const add = useCallback((title: string) => {
    dispatch(addTodo(title));
  }, []);
  return { todos, toggle, add };
}
