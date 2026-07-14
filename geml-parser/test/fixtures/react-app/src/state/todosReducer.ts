export interface Todo {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
}

export type TodoAction =
  | { type: "toggle"; id: string }
  | { type: "add"; title: string };

export function toggleTodo(id: string): TodoAction {
  return { type: "toggle", id };
}

export function addTodo(title: string): TodoAction {
  return { type: "add", title };
}

export function seedTodos(): Todo[] {
  return [makeTodo("Ship the codemap"), makeTodo("Write the tests")];
}

function makeTodo(title: string): Todo {
  return { id: Math.random().toString(36).slice(2), title, done: false, createdAt: Date.now() };
}

export function todosReducer(todos: Todo[], action: TodoAction): Todo[] {
  switch (action.type) {
    case "toggle":
      return todos.map((t) => (t.id === action.id ? { ...t, done: !t.done } : t));
    case "add":
      return [...todos, makeTodo(action.title)];
    default:
      return todos;
  }
}
