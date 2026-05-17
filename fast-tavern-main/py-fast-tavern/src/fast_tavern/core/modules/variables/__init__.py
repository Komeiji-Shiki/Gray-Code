from __future__ import annotations

from .variable_context import (
    Variables,
    VariableContext,
    create_variable_context,
    get_global_var,
    get_var,
    get_variable_changes,
    process_variable_macros,
    set_global_var,
    set_var,
)

# TS-style aliases
createVariableContext = create_variable_context
getVar = get_var
setVar = set_var
getGlobalVar = get_global_var
setGlobalVar = set_global_var
processVariableMacros = process_variable_macros
getVariableChanges = get_variable_changes

__all__ = [
    "VariableContext",
    "create_variable_context",
    "get_var",
    "set_var",
    "get_global_var",
    "set_global_var",
    "Variables",
    "process_variable_macros",
    "get_variable_changes",
    "createVariableContext",
    "getVar",
    "setVar",
    "getGlobalVar",
    "setGlobalVar",
    "processVariableMacros",
    "getVariableChanges",
]

